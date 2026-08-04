import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { buildChallenge } from "./challenge.js";
import { decodeXPayment } from "./decode.js";
import { settlePayment, type SettleResult } from "./settle.js";
import { verifyPayment } from "./verify.js";
import type { DecodedPayment, MerchantConfig } from "./types.js";

export type MerchantOptions = MerchantConfig & {
  /** The settler EOA — broadcasts settlements, pays gas. NOT the payTo. */
  facilitator: Account;
  rpcUrl: string;
  /** viem chain object (used for tx signing); optional for custom clients. */
  chain?: WalletClient["chain"];
};

export type PaymentReceipt = SettleResult & {
  payer: `0x${string}`;
  amount: bigint;
  token: `0x${string}`;
  rail: DecodedPayment["rail"];
};

export type HandleResult =
  | { status: 402; body: Record<string, unknown>; receipt?: undefined }
  | { status: 200; receipt: PaymentReceipt };

/**
 * A framework-agnostic x402/B402 merchant: give it your price, your payout
 * address, and a funded facilitator key; put `requirePayment` in front of any
 * paid route. Payable by BNB Agent Studio buyers (`bag x402 buy`), Altana
 * `fetchWithX402` buyers, and anything else speaking the B402 v2 wire.
 */
export function createX402Merchant(opts: MerchantOptions) {
  const publicClient: PublicClient = createPublicClient({
    chain: opts.chain,
    transport: http(opts.rpcUrl),
  }) as PublicClient;
  const walletClient: WalletClient = createWalletClient({
    account: opts.facilitator,
    chain: opts.chain,
    transport: http(opts.rpcUrl),
  });

  // In-process replay guard so one authorization can't settle twice in a race;
  // the on-chain nonce is the durable source of truth.
  const seen = new Set<string>();

  const challengeBody = () => buildChallenge(opts) as unknown as Record<string, unknown>;

  async function requirePayment(xPaymentHeader: string | null): Promise<HandleResult> {
    if (!xPaymentHeader) return { status: 402, body: challengeBody() };

    let decoded: DecodedPayment;
    try {
      decoded = decodeXPayment(xPaymentHeader);
    } catch (e) {
      return { status: 402, body: { ...challengeBody(), error: `invalid X-PAYMENT: ${(e as Error).message}` } };
    }

    const verdict = await verifyPayment(decoded, opts, {
      // ERC-1271/ERC-6492-capable verification: smart-account payers welcome.
      verifySignature: (args) => publicClient.verifyTypedData(args as never),
      // Checker-restricted accounts (Altana session keys) defer to settlement.
      isContract: async (address) => {
        const code = await publicClient.getCode({ address });
        return code != null && code !== "0x";
      },
    });
    if (!verdict.ok) {
      return { status: 402, body: { ...challengeBody(), error: `payment rejected: ${verdict.reason}` } };
    }

    const nonceKey =
      decoded.rail === "eip3009"
        ? `3009:${decoded.payer}:${decoded.authorization!.nonce}`
        : `p2:${decoded.payer}:${decoded.permit!.nonce}`;
    if (seen.has(nonceKey)) {
      return { status: 402, body: { ...challengeBody(), error: "payment rejected: replayed authorization" } };
    }
    seen.add(nonceKey);

    try {
      const settled = await settlePayment(decoded, opts, { wallet: walletClient, public: publicClient });
      return {
        status: 200,
        receipt: { ...settled, payer: decoded.payer, amount: decoded.amount, token: verdict.token, rail: decoded.rail },
      };
    } catch (e) {
      seen.delete(nonceKey); // let an honest retry through (e.g. RPC hiccup)
      return { status: 402, body: { ...challengeBody(), error: `settlement failed: ${(e as Error).message}` } };
    }
  }

  /** Fetch-API sugar: returns null when paid (proceed), or a Response to send. */
  async function guard(request: Request): Promise<{ response: Response | null; receipt?: PaymentReceipt }> {
    // b402 buyers send the envelope under PAYMENT-SIGNATURE; ours sends both.
    const result = await requirePayment(
      request.headers.get("X-PAYMENT") ?? request.headers.get("PAYMENT-SIGNATURE"),
    );
    if (result.status === 200) return { response: null, receipt: result.receipt };
    return {
      response: new Response(JSON.stringify(result.body), {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    };
  }

  return { challengeBody, requirePayment, guard };
}
