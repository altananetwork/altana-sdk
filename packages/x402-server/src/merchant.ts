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
import {
  settleViaFacilitator,
  settlesViaFacilitator,
  type FacilitatorConfig,
} from "./facilitator.js";
import { describeError, settlePayment, type SettleClients, type SettleResult } from "./settle.js";
import { verifyPayment } from "./verify.js";
import type { ChallengeAccept, DecodedPayment, MerchantConfig } from "./types.js";

/** Everything the merchant touches on-chain; inject your own to bring a
 * fallback transport, a nonce-managed signer, or fakes in tests. */
export type MerchantClients = {
  public: SettleClients["public"] & Pick<PublicClient, "verifyTypedData" | "getCode">;
  wallet: SettleClients["wallet"];
};

export type MerchantOptions = MerchantConfig & {
  /** The settler EOA — broadcasts settlements, pays gas. NOT the payTo. */
  facilitator: Account;
  /** RPC used to verify and settle. Required unless `clients` is given. */
  rpcUrl?: string;
  /** viem chain object (used for tx signing); optional for custom clients. */
  chain?: WalletClient["chain"];
  /** Bring your own viem clients instead of `rpcUrl` (must carry `facilitator`). */
  clients?: MerchantClients;
  /**
   * How long settlement waits for the receipt before answering with a
   * `pending` receipt (default 60s). Keep it under your buyers' HTTP timeout:
   * a buyer that gives up and retries will be told "replayed authorization".
   */
  settleTimeoutMs?: number;
  /**
   * Settle through a hosted facilitator, which broadcasts the payment and pays
   * the gas, instead of from `facilitator` (the merchant's own key). Per rail,
   * not per merchant: the rails in `FacilitatorConfig.rails` go there and every
   * other settles locally, so one route can serve both by different paths.
   * Which rails those are is configuration, not a property of the rail — the
   * receipt's `settledVia` is what actually settled it. Celo runs one, see
   * `CELO_FACILITATOR_URL`. Omitted, everything settles locally as before.
   */
  facilitatorService?: FacilitatorConfig;
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
  if (!opts.clients && !opts.rpcUrl) throw new Error("createX402Merchant: rpcUrl or clients is required");
  const publicClient: MerchantClients["public"] =
    opts.clients?.public ??
    (createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) }) as PublicClient);
  const walletClient: MerchantClients["wallet"] =
    opts.clients?.wallet ??
    createWalletClient({ account: opts.facilitator, chain: opts.chain, transport: http(opts.rpcUrl) });
  const clients = { wallet: walletClient, public: publicClient };

  // In-process replay guard so one authorization can't settle twice in a race;
  // the on-chain nonce is the durable source of truth. Once a settlement has
  // been broadcast its hash stays here until the authorization itself expires,
  // so a buyer that never received its answer can ask again (#76). Single
  // process only: behind a load balancer the on-chain nonce still refuses the
  // replay, but as "settlement failed", not "replayed authorization".
  type Seen =
    | "inflight"
    | {
        txHash: SettleResult["txHash"];
        settlement: SettleResult["settlement"];
        /** Remembered so a replayed receipt names the route that really settled. */
        settledVia: SettleResult["settledVia"];
      };
  const seen = new Map<string, { state: Seen; expiresAt: number }>();
  const sweep = (now: number) => {
    for (const [k, v] of seen) if (v.expiresAt < now) seen.delete(k);
  };

  const challenge = () => buildChallenge(opts);
  const challengeBody = () => challenge() as unknown as Record<string, unknown>;

  /**
   * The `accepts[]` entry a payment answered, to send to a facilitator as its
   * `paymentRequirements`. The buyer echoes it back when it can; when it does
   * not, the merchant's own challenge entry for that token and rail is the same
   * requirement by construction. `token` is the one verification matched, not
   * the buyer's claim, because an eip3009 envelope without an `accepted` entry
   * names no asset at all.
   */
  function requirementsFor(decoded: DecodedPayment, token: `0x${string}`): Record<string, unknown> {
    if (decoded.accepted) return decoded.accepted;
    const wanted = decoded.rail === "eip3009" ? "eip3009" : "permit2-exact";
    const match = challenge().accepts.find(
      (a: ChallengeAccept) =>
        a.asset.toLowerCase() === token.toLowerCase() && a.extra.assetTransferMethod === wanted,
    );
    if (!match) {
      throw new Error(
        `no accepts[] entry for ${decoded.rail} on ${token}: the payment does not answer this merchant's challenge`,
      );
    }
    return match as unknown as Record<string, unknown>;
  }

  /** The facilitator when it takes this rail, the merchant's own key otherwise. */
  function settle(decoded: DecodedPayment, token: `0x${string}`): Promise<SettleResult> {
    const service = opts.facilitatorService;
    if (service && settlesViaFacilitator(decoded.rail, service)) {
      return settleViaFacilitator(decoded, requirementsFor(decoded, token), service);
    }
    return settlePayment(decoded, opts, clients, { receiptTimeoutMs: opts.settleTimeoutMs });
  }

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

    const now = Math.floor(Date.now() / 1000);
    sweep(now);
    const nonceKey =
      decoded.rail === "eip3009"
        ? `3009:${decoded.payer}:${decoded.authorization!.nonce}`
        : `p2:${decoded.payer}:${decoded.permit!.nonce}`;
    // verifyPayment already refused anything past this point in time.
    const expiresAt = Number(decoded.authorization?.validBefore ?? decoded.permit?.deadline ?? now + 600);
    const receiptOf = (settled: SettleResult): PaymentReceipt => ({
      ...settled,
      payer: decoded.payer,
      amount: decoded.amount,
      token: verdict.token,
      rail: decoded.rail,
    });

    const prior = seen.get(nonceKey);
    if (prior) {
      if (prior.state === "inflight" || prior.state.settlement === "confirmed") {
        return { status: 402, body: { ...challengeBody(), error: "payment rejected: replayed authorization" } };
      }
      // The same buyer asking again about a payment we broadcast but could not
      // confirm. Look once more; never hand out a fresh challenge for it.
      const { txHash } = prior.state;
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (receipt?.status === "reverted") {
        seen.delete(nonceKey); // it landed and failed: the authorization is unspent
        return { status: 402, body: { ...challengeBody(), error: `settlement failed: transaction ${txHash} reverted` } };
      }
      const settledVia = prior.state.settledVia;
      if (receipt?.status === "success") {
        seen.set(nonceKey, { state: { txHash, settlement: "confirmed", settledVia }, expiresAt });
        return { status: 200, receipt: receiptOf({ txHash, settlement: "confirmed", settledVia }) };
      }
      return {
        status: 200,
        receipt: receiptOf({ txHash, settlement: "pending", pendingReason: "receipt not yet available", settledVia }),
      };
    }
    seen.set(nonceKey, { state: "inflight", expiresAt });

    try {
      const settled = await settle(decoded, verdict.token);
      // Confirmed or pending, the authorization is spent (or about to be): keep it.
      seen.set(nonceKey, {
        state: { txHash: settled.txHash, settlement: settled.settlement, settledVia: settled.settledVia },
        expiresAt,
      });
      return { status: 200, receipt: receiptOf(settled) };
    } catch (e) {
      // Nothing was broadcast, or it reverted / was replaced and the nonce is
      // unspent: an honest retry may proceed. (An unreadable outcome after a
      // broadcast is not an error — see SettleResult.settlement.)
      seen.delete(nonceKey);
      return { status: 402, body: { ...challengeBody(), error: `settlement failed: ${describeError(e)}` } };
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
