/**
 * Settling through a hosted facilitator instead of the merchant's own key.
 *
 * Two levels: the facilitator client on its own (the x402 v2 wire body, and
 * every answer it can give mapped to a settlement outcome), and the merchant
 * boundary (which rails go where, and that a facilitated pending payment is
 * still a 200 with a hash rather than a fresh challenge, which is what would
 * make a buyer pay twice).
 *
 * Celo's own facilitator URLs are asserted against its documentation; a live
 * check of both `/supported` endpoints is in
 * `celo-harness/evidence/2026-09-29-x402-celo-facilitator.md`.
 */
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildEip3009TypedData } from "@altananetwork/sdk";
import { createX402Merchant } from "./merchant.js";
import {
  CELO_FACILITATOR_URL,
  CELO_SEPOLIA_FACILITATOR_URL,
  DEFAULT_FACILITATOR_RAILS,
  facilitatorSupported,
  facilitatorUrlFor,
  settleViaFacilitator,
  settlesViaFacilitator,
  supportsExactOn,
  type FacilitatorConfig,
} from "./facilitator.js";
import { USDC_CELO_SEPOLIA, USDT_CELO_SEPOLIA } from "./tokens.js";
import type { DecodedPayment, MerchantConfig } from "./types.js";

const MERCHANT = "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA" as const;
const SPENDER = "0x0000000000000000000000000000000000000002" as const;
const URL = CELO_SEPOLIA_FACILITATOR_URL;
const TX = `0x${"ab".repeat(32)}` as const;

const CFG: MerchantConfig = {
  chainId: 11142220,
  payTo: MERCHANT,
  price: 200_000n, // 0.2 USDC, 6 decimals
  rails: [
    { rail: "eip3009", token: USDC_CELO_SEPOLIA },
    { rail: "permit2-exact", token: USDT_CELO_SEPOLIA, spender: SPENDER },
  ],
  resource: "https://api.example.com/quote",
};

/** A recorded fetch that answers /settle with `answer`. */
function stubFetch(answer: { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const decoded = (rail: DecodedPayment["rail"] = "eip3009"): DecodedPayment => ({
  rail,
  payer: "0x1111111111111111111111111111111111111111",
  amount: 200_000n,
  token: USDC_CELO_SEPOLIA.address,
  signature: "0xdead",
  raw: { x402Version: 2, payload: { signature: "0xdead" } },
});

describe("Celo's facilitator, per Celo's x402 documentation", () => {
  test("the two URLs, and the chain they belong to", () => {
    expect(CELO_FACILITATOR_URL).toBe("https://api.x402.celo.org");
    expect(CELO_SEPOLIA_FACILITATOR_URL).toBe("https://api.x402.sepolia.celo.org");
    expect(facilitatorUrlFor(42220)).toBe(CELO_FACILITATOR_URL);
    expect(facilitatorUrlFor(11142220)).toBe(CELO_SEPOLIA_FACILITATOR_URL);
  });

  test("no facilitator is claimed for a chain that has none", () => {
    for (const chainId of [1, 56, 97, 11155111, 84532]) {
      expect(facilitatorUrlFor(chainId)).toBeUndefined();
    }
  });

  // The `exact` scheme on Celo settles EIP-3009, so that is the only rail sent
  // there by default; a Permit2 payment still settles from the merchant's key.
  test("only the eip3009 rail goes to the facilitator by default", () => {
    expect(DEFAULT_FACILITATOR_RAILS).toEqual(["eip3009"]);
    const f: FacilitatorConfig = { url: URL };
    expect(settlesViaFacilitator("eip3009", f)).toBe(true);
    expect(settlesViaFacilitator("permit2", f)).toBe(false);
    expect(settlesViaFacilitator("permit2-witness", f)).toBe(false);
  });

  test("a merchant can widen or narrow which rails it sends", () => {
    expect(settlesViaFacilitator("permit2", { url: URL, rails: ["eip3009", "permit2"] })).toBe(true);
    expect(settlesViaFacilitator("eip3009", { url: URL, rails: [] })).toBe(false);
  });
});

describe("GET /supported", () => {
  test("reads the kinds and the extensions, and answers about a chain", async () => {
    // The live Celo Sepolia answer, recorded 2026-09-29.
    const body = {
      kinds: [
        { x402Version: 1, scheme: "exact", network: "celo-sepolia" },
        { x402Version: 2, scheme: "exact", network: "eip155:11142220", extra: { extensions: ["eip2612GasSponsoring"] } },
      ],
      extensions: ["eip2612GasSponsoring"],
      signers: { "eip155:11142220": ["0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48"] },
    };
    const { fn, calls } = stubFetch({ body });
    const supported = await facilitatorSupported({ url: `${URL}/`, fetch: fn });
    expect(calls[0]!.url).toBe(`${URL}/supported`);
    expect(supportsExactOn(supported.kinds, 11142220)).toBe(true);
    expect(supportsExactOn(supported.kinds, 42220)).toBe(false);
    expect(supported.extensions).toEqual(["eip2612GasSponsoring"]);
  });

  test("a facilitator that will not answer says so, rather than looking unsupported", async () => {
    const { fn } = stubFetch({ status: 503 });
    await expect(facilitatorSupported({ url: URL, fetch: fn })).rejects.toThrow(/answered \/supported with 503/);
  });
});

describe("POST /settle", () => {
  test("sends the x402 v2 body: the buyer's payload untouched, and the requirement it chose", async () => {
    const { fn, calls } = stubFetch({ body: { success: true, transaction: TX, network: "eip155:11142220" } });
    const payment = decoded();
    const requirements = { scheme: "exact", network: "eip155:11142220", asset: USDC_CELO_SEPOLIA.address };
    const result = await settleViaFacilitator(payment, requirements, { url: URL, apiKey: "k", fetch: fn });

    expect(result).toEqual({ txHash: TX, settlement: "confirmed" });
    expect(calls[0]!.url).toBe(`${URL}/settle`);
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("k");
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.x402Version).toBe(2);
    // Untouched on purpose: the facilitator checks the signature against what
    // the buyer signed, and any normalization of ours would change it.
    expect(sent.paymentPayload).toEqual(payment.raw);
    expect(sent.paymentRequirements).toEqual(requirements);
  });

  test("no API key is sent when none is configured", async () => {
    const { fn, calls } = stubFetch({ body: { success: true, transaction: TX } });
    await settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn });
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBeUndefined();
  });

  // settlement_pending is the spec's "broadcast, outcome not readable yet".
  // Treating it as a failure would hand the buyer a fresh challenge for a
  // payment already on its way, and it would pay twice.
  test("settlement_pending is a pending settlement with the hash, not an error", async () => {
    const { fn } = stubFetch({ body: { success: false, errorReason: "settlement_pending", transaction: TX } });
    const result = await settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn });
    expect(result.settlement).toBe("pending");
    expect(result.txHash).toBe(TX);
    expect(result.pendingReason).toContain("facilitator");
  });

  test("settlement_pending without a hash is an error: there is nothing to reconcile against", async () => {
    const { fn } = stubFetch({ body: { success: false, errorReason: "settlement_pending", transaction: "" } });
    await expect(settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn })).rejects.toThrow(/no transaction hash/);
  });

  test("a refusal names the facilitator's own reason", async () => {
    const { fn } = stubFetch({ body: { success: false, errorReason: "insufficient_funds", transaction: "" } });
    await expect(settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn })).rejects.toThrow(/refused to settle: insufficient_funds/);
  });

  test("success with an empty transaction is an error, not a confirmed payment", async () => {
    const { fn } = stubFetch({ body: { success: true, transaction: "" } });
    await expect(settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn })).rejects.toThrow(/success with no transaction hash/);
  });

  // 401 is the one worth naming: it fails for every buyer and has nothing to do
  // with the payment, so the message says what to fix and where to get a key.
  test("401 says the API key is the problem, and where Celo issues one", async () => {
    const { fn } = stubFetch({ status: 401, body: { error: "unauthorized", message: "Missing X-API-Key" } });
    const thrown = await settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    expect(thrown).toContain("rejected the API key");
    expect(thrown).toContain("https://x402.celo.org");
  });

  test("another HTTP error carries its status and the facilitator's reason", async () => {
    const { fn } = stubFetch({ status: 500, body: { errorReason: "internal" } });
    await expect(settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn })).rejects.toThrow(/answered 500: internal/);
  });

  test("an unreachable facilitator is an error naming it: nothing was broadcast", async () => {
    const fn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(settleViaFacilitator(decoded(), {}, { url: URL, fetch: fn })).rejects.toThrow(/could not be reached/);
  });
});

/**
 * The merchant boundary. Real signing, real decode and verify; only the chain
 * and the facilitator's HTTP are faked.
 */
describe("createX402Merchant with facilitatorService", () => {
  const PAYER = privateKeyToAccount(generatePrivateKey());

  async function usdcPayment(nonce: `0x${string}`, withAccepted = true) {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: PAYER.address,
      to: MERCHANT,
      value: CFG.price.toString(),
      validAfter: String(now - 60),
      validBefore: String(now + 600),
      nonce,
    };
    const signature = await PAYER.signTypedData(
      buildEip3009TypedData({
        chainId: CFG.chainId,
        token: USDC_CELO_SEPOLIA.address,
        name: USDC_CELO_SEPOLIA.name,
        version: USDC_CELO_SEPOLIA.version,
        from: auth.from,
        to: auth.to,
        value: CFG.price,
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce,
      }) as never,
    );
    const envelope: Record<string, unknown> = {
      x402Version: 2,
      scheme: "exact",
      network: `eip155:${CFG.chainId}`,
      payload: { signature, authorization: auth },
      ...(withAccepted
        ? {
            accepted: {
              scheme: "exact",
              network: `eip155:${CFG.chainId}`,
              asset: USDC_CELO_SEPOLIA.address,
              payTo: MERCHANT,
              amount: CFG.price.toString(),
              extra: {
                name: USDC_CELO_SEPOLIA.name,
                version: USDC_CELO_SEPOLIA.version,
                assetTransferMethod: "eip3009",
              },
            },
          }
        : {}),
    };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
  }

  function merchantOn(service: FacilitatorConfig | undefined, onBroadcast?: () => void) {
    const local = { broadcasts: 0 };
    const clients = {
      public: {
        verifyTypedData: async () => true,
        getCode: async () => "0x",
        getTransaction: async () => null,
        getTransactionReceipt: async () => null,
        waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => ({
          transactionHash: hash,
          status: "success" as const,
        }),
      },
      wallet: {
        account: privateKeyToAccount(generatePrivateKey()),
        chain: undefined,
        prepareTransactionRequest: async (req: Record<string, unknown>) => ({
          ...req,
          chainId: CFG.chainId,
          nonce: 0,
          gas: 100_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
          type: "eip1559",
        }),
        sendRawTransaction: async () => {
          local.broadcasts++;
          onBroadcast?.();
          return TX;
        },
      },
    };
    const merchant = createX402Merchant({
      ...CFG,
      facilitator: clients.wallet.account,
      clients: clients as never,
      ...(service ? { facilitatorService: service } : {}),
    });
    return { merchant, local };
  }

  test("an eip3009 payment settles through the facilitator, and the merchant broadcasts nothing", async () => {
    const { fn, calls } = stubFetch({ body: { success: true, transaction: TX, network: "eip155:11142220" } });
    const { merchant, local } = merchantOn({ url: URL, apiKey: "k", fetch: fn });

    const result = await merchant.requirePayment(await usdcPayment(`0x${"c1".repeat(32)}`));
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.receipt.txHash).toBe(TX);
    expect(result.receipt.settlement).toBe("confirmed");
    expect(result.receipt.payer.toLowerCase()).toBe(PAYER.address.toLowerCase());
    expect(calls).toHaveLength(1);
    expect(local.broadcasts).toBe(0);
  });

  test("the requirement sent is the buyer's own accepted entry when it echoes one", async () => {
    const { fn, calls } = stubFetch({ body: { success: true, transaction: TX } });
    const { merchant } = merchantOn({ url: URL, fetch: fn });
    await merchant.requirePayment(await usdcPayment(`0x${"c2".repeat(32)}`));
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.paymentRequirements.extra.assetTransferMethod).toBe("eip3009");
    expect(sent.paymentRequirements.asset.toLowerCase()).toBe(USDC_CELO_SEPOLIA.address.toLowerCase());
  });

  // A buyer need not echo the requirement. The merchant's own challenge entry
  // for that token and rail is the same requirement by construction.
  test("a buyer that echoes no accepted entry still settles, from the merchant's challenge", async () => {
    const { fn, calls } = stubFetch({ body: { success: true, transaction: TX } });
    const { merchant } = merchantOn({ url: URL, fetch: fn });
    const result = await merchant.requirePayment(await usdcPayment(`0x${"c3".repeat(32)}`, false));
    expect(result.status).toBe(200);
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.paymentRequirements.payTo).toBe(MERCHANT);
    expect(sent.paymentRequirements.amount).toBe(CFG.price.toString());
    expect(sent.paymentRequirements.network).toBe("eip155:11142220");
  });

  test("with no facilitatorService the merchant settles from its own key, as before", async () => {
    const { merchant, local } = merchantOn(undefined);
    const result = await merchant.requirePayment(await usdcPayment(`0x${"c4".repeat(32)}`));
    expect(result.status).toBe(200);
    expect(local.broadcasts).toBe(1);
  });

  test("a facilitator refusal is a 402 the buyer may retry, and the nonce is released", async () => {
    const { fn, calls } = stubFetch({ body: { success: false, errorReason: "insufficient_funds", transaction: "" } });
    const { merchant } = merchantOn({ url: URL, apiKey: "k", fetch: fn });
    const header = await usdcPayment(`0x${"c5".repeat(32)}`);

    const first = await merchant.requirePayment(header);
    expect(first.status).toBe(402);
    if (first.status !== 402) return;
    expect(String(first.body.error)).toContain("settlement failed");
    expect(String(first.body.error)).toContain("insufficient_funds");

    // Nothing was broadcast, so asking again is honest and is tried again.
    const again = await merchant.requirePayment(header);
    expect(again.status).toBe(402);
    expect(calls).toHaveLength(2);
  });

  test("a facilitated pending settlement is a 200 with the hash, and the buyer never pays twice", async () => {
    const { fn, calls } = stubFetch({ body: { success: false, errorReason: "settlement_pending", transaction: TX } });
    const { merchant } = merchantOn({ url: URL, apiKey: "k", fetch: fn });
    const header = await usdcPayment(`0x${"c6".repeat(32)}`);

    const first = await merchant.requirePayment(header);
    expect(first.status).toBe(200);
    if (first.status !== 200) return;
    expect(first.receipt.settlement).toBe("pending");
    expect(first.receipt.txHash).toBe(TX);

    // The buyer asks again, having never seen the 200: the same payment, not a
    // fresh challenge, and the facilitator is not asked a second time.
    const again = await merchant.requirePayment(header);
    expect(again.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
