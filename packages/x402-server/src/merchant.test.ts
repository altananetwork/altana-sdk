/**
 * Wire-level tests for the seller side of x402/B402.
 *
 * The two buyer families this package must accept, byte-for-byte:
 *
 *  - **BNB Agent Studio** (`bnbagent_studio_core.x402.buyer`): EOA wallet,
 *    signs EIP-3009 `TransferWithAuthorization` on $U only, envelope
 *    `{x402Version:2, resource, accepted, payload:{signature, authorization}}`
 *    with a backdated `validAfter` and string-typed authorization values.
 *
 *  - **Altana SDK** (`fetchWithX402`): smart-account session key (ERC-1271),
 *    envelope `{x402Version, scheme, network, accepted, payload}`; permit2
 *    rail carries `payload.permit` (+ optional `witness`) and `payload.from`,
 *    eip3009 rail carries `payload.authorization`.
 */
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyTypedData } from "viem";
import { buildEip3009TypedData, buildPermit2WitnessTypedData } from "@altananetwork/sdk";

import { buildChallenge } from "./challenge.js";
import { createX402Merchant } from "./merchant.js";
import { decodeXPayment } from "./decode.js";
import { verifyPayment } from "./verify.js";
import { U_TOKEN, USDT_BSC } from "./tokens.js";
import type { MerchantConfig } from "./types.js";

const MERCHANT = "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA" as const;
const FACILITATOR = "0x0000000000000000000000000000000000000001" as const;
const NOW = 1_800_000_000;

const CFG: MerchantConfig = {
  chainId: 56,
  payTo: MERCHANT,
  price: 200_000_000_000_000_000n, // 0.2 $U
  minPrice: 50_000_000_000_000_000n,
  maxPrice: 2_000_000_000_000_000_000n,
  rails: [
    { rail: "eip3009", token: U_TOKEN[56] },
    { rail: "permit2-exact", token: USDT_BSC, spender: FACILITATOR },
  ],
  maxTimeoutSeconds: 600,
  resource: "https://api.example.com/audit",
};

/** Sign an EIP-3009 authorization the way the Studio buyer does (EOA). */
async function studioPayment(over: Partial<Record<string, unknown>> = {}) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const auth = {
    from: account.address,
    to: MERCHANT as string,
    value: CFG.price.toString(),
    validAfter: String(NOW - 600), // studio backdates
    validBefore: String(NOW + 600),
    nonce: `0x${"11".repeat(32)}`,
    ...over,
  };
  const typed = buildEip3009TypedData({
    chainId: 56,
    token: U_TOKEN[56].address,
    name: U_TOKEN[56].name,
    version: U_TOKEN[56].version,
    from: auth.from as `0x${string}`,
    to: auth.to as `0x${string}`,
    value: BigInt(auth.value as string),
    validAfter: BigInt(auth.validAfter as string),
    validBefore: BigInt(auth.validBefore as string),
    nonce: auth.nonce as `0x${string}`,
  });
  const signature = await account.signTypedData(typed as never);
  // Exactly bnbagent_studio_core.x402.signing.build_x_payment_header:
  const envelope = {
    x402Version: 2,
    resource: CFG.resource,
    accepted: {
      scheme: "exact",
      network: "eip155:56",
      asset: U_TOKEN[56].address,
      payTo: MERCHANT,
      amount: CFG.price.toString(),
      maxTimeoutSeconds: 600,
      extra: { name: U_TOKEN[56].name, version: U_TOKEN[56].version, assetTransferMethod: "eip3009" },
    },
    payload: { signature, authorization: auth },
  };
  return { header: Buffer.from(JSON.stringify(envelope)).toString("base64"), account };
}

describe("buildChallenge", () => {
  test("emits a v2 challenge payable by both Studio (eip3009 $U) and Altana (permit2-exact) buyers", () => {
    const body = buildChallenge(CFG);
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(2);

    const eip3009 = body.accepts.find((a) => a.extra?.assetTransferMethod === "eip3009")!;
    // Shape the Studio buyer's _parse_accepted requires:
    expect(eip3009.scheme).toBe("exact");
    expect(eip3009.network).toBe("eip155:56");
    expect(eip3009.asset.toLowerCase()).toBe(U_TOKEN[56].address.toLowerCase());
    expect(eip3009.payTo).toBe(MERCHANT);
    expect(eip3009.amount).toBe(CFG.price.toString());
    expect(eip3009.maxTimeoutSeconds).toBe(600);
    // Altana's signX402Payment additionally needs the EIP-712 domain:
    expect(eip3009.extra?.name).toBe("United Stables");
    expect(eip3009.extra?.version).toBe("1");

    const permit2 = body.accepts.find((a) => a.extra?.assetTransferMethod === "permit2-exact")!;
    expect(permit2.scheme).toBe("exact");
    expect(permit2.extra?.spenderAddress).toBe(FACILITATOR);
  });

  test("clamps the quoted price into [minPrice, maxPrice]", () => {
    const low = buildChallenge({ ...CFG, price: 1n });
    expect(low.accepts[0]!.amount).toBe(CFG.minPrice!.toString());
    const high = buildChallenge({ ...CFG, price: 10n ** 20n });
    expect(high.accepts[0]!.amount).toBe(CFG.maxPrice!.toString());
  });
});

describe("decodeXPayment", () => {
  test("decodes the Studio buyer envelope (resource + accepted, string values)", async () => {
    const { header, account } = await studioPayment();
    const d = decodeXPayment(header);
    expect(d.rail).toBe("eip3009");
    expect(d.payer.toLowerCase()).toBe(account.address.toLowerCase());
    expect(d.amount).toBe(CFG.price);
    expect(d.authorization!.to).toBe(MERCHANT);
  });

  test("decodes the Altana permit2-exact (witness) envelope", () => {
    const envelope = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      accepted: { scheme: "exact", network: "eip155:56", asset: USDT_BSC.address, payTo: MERCHANT, amount: "5", extra: { assetTransferMethod: "permit2-exact", spenderAddress: FACILITATOR } },
      payload: {
        signature: "0x" + "ab".repeat(98),
        from: "0x00000000000000000000000000000000000000A0",
        permit: {
          permitted: { token: USDT_BSC.address, amount: "5" },
          spender: FACILITATOR,
          nonce: "42",
          deadline: String(NOW + 600),
          witness: { to: MERCHANT, validAfter: "0" },
        },
      },
    };
    const d = decodeXPayment(Buffer.from(JSON.stringify(envelope)).toString("base64"));
    expect(d.rail).toBe("permit2-witness");
    expect(d.payer).toBe("0x00000000000000000000000000000000000000A0");
    expect(d.amount).toBe(5n);
    expect(d.permit!.witness!.to).toBe(MERCHANT);
  });

  test("decodes the b402 permit2Authorization dialect (from nested, no payload.from)", () => {
    // What a real b402 buyer sends: the same authorization under a different
    // key, with `from` inside it rather than as a sibling field.
    const envelope = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      resource: { url: "https://merchant.example/premium", mimeType: "application/json" },
      accepted: { scheme: "exact", network: "eip155:56", asset: USDT_BSC.address, payTo: MERCHANT, amount: "5", extra: { assetTransferMethod: "permit2-exact", spenderAddress: FACILITATOR } },
      payload: {
        signature: "0x" + "ab".repeat(98),
        permit2Authorization: {
          permitted: { token: USDT_BSC.address, amount: "5" },
          from: "0x00000000000000000000000000000000000000A0",
          spender: FACILITATOR,
          nonce: "42",
          deadline: String(NOW + 600),
          witness: { to: MERCHANT, validAfter: "0" },
        },
      },
    };
    const d = decodeXPayment(Buffer.from(JSON.stringify(envelope)).toString("base64"));
    expect(d.rail).toBe("permit2-witness");
    expect(d.payer).toBe("0x00000000000000000000000000000000000000A0");
    expect(d.amount).toBe(5n);
    expect(d.permit!.witness!.to).toBe(MERCHANT);
    expect(d.permit!.spender).toBe(FACILITATOR);
  });

  test("both permit2 dialects decode identically when a buyer sends both", () => {
    // Our own buyer emits `permit` + `from` AND `permit2Authorization`.
    const permitted = { token: USDT_BSC.address, amount: "5" };
    const common = {
      spender: FACILITATOR,
      nonce: "42",
      deadline: String(NOW + 600),
      witness: { to: MERCHANT, validAfter: "0" },
    };
    const base = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      accepted: { scheme: "exact", network: "eip155:56", asset: USDT_BSC.address, payTo: MERCHANT, amount: "5", extra: { assetTransferMethod: "permit2-exact", spenderAddress: FACILITATOR } },
    };
    const from = "0x00000000000000000000000000000000000000A0";
    const signature = "0x" + "ab".repeat(98);

    const both = decodeXPayment(
      Buffer.from(
        JSON.stringify({
          ...base,
          payload: {
            signature,
            from,
            permit: { permitted, ...common },
            permit2Authorization: { permitted, from, ...common },
          },
        }),
      ).toString("base64"),
    );
    const legacyOnly = decodeXPayment(
      Buffer.from(
        JSON.stringify({ ...base, payload: { signature, from, permit: { permitted, ...common } } }),
      ).toString("base64"),
    );

    expect(both.rail).toBe(legacyOnly.rail);
    expect(both.payer).toBe(legacyOnly.payer);
    expect(both.amount).toBe(legacyOnly.amount);
    expect(both.permit).toEqual(legacyOnly.permit);
  });

  test("rejects garbage", () => {
    expect(() => decodeXPayment("not base64 json !!!")).toThrow();
  });
});

describe("verifyPayment (off-chain checks + EOA signature)", () => {
  const verify = (header: string, over: Partial<MerchantConfig> = {}) =>
    verifyPayment(decodeXPayment(header), { ...CFG, ...over }, {
      now: NOW,
      verifySignature: (args) => verifyTypedData(args as never),
    });

  test("accepts a valid Studio payment", async () => {
    const { header } = await studioPayment();
    const r = await verify(header);
    expect(r).toEqual({ ok: true, rail: "eip3009", payer: expect.any(String), amount: CFG.price, token: expect.any(String) });
  });

  test("rejects a payment to the wrong recipient", async () => {
    const { header } = await studioPayment({ to: "0x000000000000000000000000000000000000dEaD" });
    const r = await verify(header);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("payTo");
  });

  test("rejects an underpayment", async () => {
    const { header } = await studioPayment({ value: "1" });
    const r = await verify(header);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("amount");
  });

  test("rejects an overpayment above maxPrice (buyer protection)", async () => {
    const { header } = await studioPayment({ value: (CFG.maxPrice! + 1n).toString() });
    const r = await verify(header);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("amount");
  });

  test("rejects an expired authorization", async () => {
    const { header } = await studioPayment({ validBefore: String(NOW - 1) });
    const r = await verify(header);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("expired");
  });

  test("rejects a tampered authorization (signature over different values)", async () => {
    const { header } = await studioPayment();
    const env = JSON.parse(Buffer.from(header, "base64").toString());
    env.payload.authorization.value = CFG.maxPrice!.toString(); // inflate after signing
    const tampered = Buffer.from(JSON.stringify(env)).toString("base64");
    const r = await verify(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("signature");
  });

  test("rejects a token not offered by any rail", async () => {
    const { header } = await studioPayment();
    const r = await verify(header, { rails: [{ rail: "permit2-exact", token: USDT_BSC, spender: FACILITATOR }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("token");
  });

  test("accepts a valid permit2-witness payment (EOA-signed)", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const permitInput = {
      chainId: 56,
      token: USDT_BSC.address,
      amount: CFG.price,
      spender: FACILITATOR,
      nonce: 42n,
      deadline: BigInt(NOW + 600),
      to: MERCHANT,
      validAfter: 0n,
    } as const;
    const signature = await account.signTypedData(buildPermit2WitnessTypedData(permitInput) as never);
    const envelope = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      payload: {
        signature,
        from: account.address,
        permit: {
          permitted: { token: USDT_BSC.address, amount: CFG.price.toString() },
          spender: FACILITATOR,
          nonce: "42",
          deadline: String(NOW + 600),
          witness: { to: MERCHANT, validAfter: "0" },
        },
      },
    };
    const r = await verify(Buffer.from(JSON.stringify(envelope)).toString("base64"));
    expect(r).toMatchObject({ ok: true, rail: "permit2-witness", amount: CFG.price });
  });

  test("defers signature judgment to settlement for contract payers (checker-restricted ERC-1271)", async () => {
    const envelope = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      payload: {
        signature: "0x" + "ab".repeat(98), // Altana nested-1271 envelope, unverifiable off-chain
        from: "0x00000000000000000000000000000000000000A0",
        permit: {
          permitted: { token: USDT_BSC.address, amount: CFG.price.toString() },
          spender: FACILITATOR,
          nonce: "42",
          deadline: String(NOW + 600),
          witness: { to: MERCHANT, validAfter: "0" },
        },
      },
    };
    const header = Buffer.from(JSON.stringify(envelope)).toString("base64");
    const asEoa = await verifyPayment(decodeXPayment(header), CFG, {
      now: NOW,
      verifySignature: () => false,
      isContract: () => false, // EOA payer with a bad signature → reject
    });
    expect(asEoa.ok).toBe(false);
    const asContract = await verifyPayment(decodeXPayment(header), CFG, {
      now: NOW,
      verifySignature: () => false,
      isContract: () => true, // contract payer → settlement decides
    });
    expect(asContract.ok).toBe(true);
  });

  test("rejects a permit2 payment whose spender is not the configured settler", async () => {
    const envelope = {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:56",
      payload: {
        signature: "0x" + "ab".repeat(65),
        from: "0x00000000000000000000000000000000000000A0",
        permit: {
          permitted: { token: USDT_BSC.address, amount: CFG.price.toString() },
          spender: "0x000000000000000000000000000000000000BEEF".slice(0, 42),
          nonce: "42",
          deadline: String(NOW + 600),
        },
      },
    };
    const r = await verify(Buffer.from(JSON.stringify(envelope)).toString("base64"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("spender");
  });
});

describe("b402 wire compatibility", () => {
  test("buildChallenge normalizes a bare-string resource into the object form", () => {
    const c = buildChallenge({ ...CFG, resource: "https://api.example.com/audit" });
    // Real b402 challenges carry an object; buyers echo it into the envelope.
    expect(c.resource).toEqual({ url: "https://api.example.com/audit" });
  });

  test("buildChallenge passes an object resource through untouched", () => {
    const resource = {
      url: "https://api.example.com/audit",
      description: "Supply chain audit",
      mimeType: "application/json",
    };
    const c = buildChallenge({ ...CFG, resource });
    expect(c.resource).toEqual(resource);
  });

  test("buildChallenge omits resource when the merchant configured none", () => {
    const { resource: _drop, ...noResource } = CFG;
    expect(buildChallenge(noResource).resource).toBeUndefined();
  });

  test("guard reads the payment from PAYMENT-SIGNATURE when X-PAYMENT is absent", async () => {
    const merchant = createX402Merchant({
      ...CFG,
      facilitator: privateKeyToAccount(generatePrivateKey()),
      rpcUrl: "http://127.0.0.1:1", // never dialed: decode fails first
    });

    // A header that reaches the decoder produces an "invalid X-PAYMENT" error;
    // a header that was never read produces the bare challenge with no error.
    const read = await merchant.guard(
      new Request("https://api.example.com/audit", {
        headers: { "PAYMENT-SIGNATURE": "not base64 json !!!" },
      }),
    );
    const body = await read.response!.json();
    expect(read.response!.status).toBe(402);
    expect(String(body.error)).toContain("invalid X-PAYMENT");

    const unpaid = await merchant.guard(new Request("https://api.example.com/audit"));
    expect((await unpaid.response!.json()).error).toBe("payment required");
  });

  test("guard still prefers X-PAYMENT when both headers are present", async () => {
    const merchant = createX402Merchant({
      ...CFG,
      facilitator: privateKeyToAccount(generatePrivateKey()),
      rpcUrl: "http://127.0.0.1:1",
    });

    const res = await merchant.guard(
      new Request("https://api.example.com/audit", {
        headers: {
          "X-PAYMENT": "not base64 json !!!",
          "PAYMENT-SIGNATURE": "not base64 json !!!",
        },
      }),
    );
    const body = await res.response!.json();
    expect(String(body.error)).toContain("invalid X-PAYMENT");
  });
});

/**
 * Settlement outcomes at the merchant boundary (#76). Real signing and real
 * decode/verify; only the chain is faked, through the `clients` seam.
 */
describe("requirePayment: a broadcast payment is never answered with a fresh challenge", () => {
  const PAYER = privateKeyToAccount(generatePrivateKey());

  /** A Studio-style payment valid against the wall clock (the merchant does not take `now`). */
  async function livePayment(nonce: `0x${string}`) {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: PAYER.address, to: MERCHANT, value: CFG.price.toString(),
      validAfter: String(now - 60), validBefore: String(now + 600), nonce,
    };
    const signature = await PAYER.signTypedData(
      buildEip3009TypedData({
        chainId: 56, token: U_TOKEN[56].address, name: U_TOKEN[56].name, version: U_TOKEN[56].version,
        from: auth.from, to: auth.to, value: CFG.price, validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce,
      }) as never,
    );
    const envelope = {
      x402Version: 2, scheme: "exact", network: "eip155:56",
      accepted: { scheme: "exact", network: "eip155:56", asset: U_TOKEN[56].address, payTo: MERCHANT, amount: CFG.price.toString(), extra: { name: U_TOKEN[56].name, version: U_TOKEN[56].version, assetTransferMethod: "eip3009" } },
      payload: { signature, authorization: auth },
    };
    return Buffer.from(JSON.stringify(envelope)).toString("base64");
  }

  type Chain = {
    /** What the receipt wait does per broadcast (indexed by call). */
    wait: (hash: `0x${string}`) => Promise<{ transactionHash: `0x${string}`; status: "success" | "reverted" }>;
    /** What a later direct receipt read returns. */
    read?: () => Promise<{ status: "success" | "reverted" } | null>;
    prepare?: (req: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const prepared = (req: Record<string, unknown>) =>
    ({ ...req, chainId: 56, nonce: 0, gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, type: "eip1559" });
  function merchantOn(chain: Chain) {
    const facilitator = privateKeyToAccount(generatePrivateKey());
    const calls = { broadcasts: 0 };
    const clients = {
      public: {
        verifyTypedData: async () => true,
        getCode: async () => "0x",
        getTransaction: async () => null,
        getTransactionReceipt: async () => (chain.read ? chain.read() : null),
        waitForTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => chain.wait(hash),
      },
      wallet: {
        account: facilitator,
        chain: undefined,
        prepareTransactionRequest: async (req: Record<string, unknown>) =>
          chain.prepare ? chain.prepare(req) : prepared(req),
        sendRawTransaction: async () => { calls.broadcasts++; return "0x"; },
      },
    };
    const merchant = createX402Merchant({ ...CFG, facilitator, clients: clients as never });
    return { merchant, calls };
  }
  const rpcDown = Object.assign(new Error("Missing or invalid parameters.\n\nURL: http://rpc.example/?key=SECRET"), {
    shortMessage: "Missing or invalid parameters.", details: "receipt read unavailable",
  });

  test("receipt unreadable → 200 with a pending receipt and the hash; the nonce stays claimed", async () => {
    const { merchant, calls } = merchantOn({ wait: async () => { throw rpcDown; } });
    const header = await livePayment(`0x${"a1".repeat(32)}`);

    const first = await merchant.requirePayment(header);
    expect(first.status).toBe(200);
    if (first.status !== 200) return;
    expect(first.receipt.settlement).toBe("pending");
    expect(first.receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.receipt.pendingReason).not.toContain("http");
    expect(calls.broadcasts).toBe(1);

    // The buyer asks again (it may never have seen the 200): no second broadcast.
    const again = await merchant.requirePayment(header);
    expect(again.status).toBe(200);
    if (again.status === 200) {
      expect(again.receipt.settlement).toBe("pending");
      expect(again.receipt.txHash).toBe(first.receipt.txHash);
    }
    expect(calls.broadcasts).toBe(1);
  });

  test("pending, then the receipt becomes readable → confirmed on re-ask; a third replay is refused", async () => {
    let reads = 0;
    const { merchant, calls } = merchantOn({
      wait: async () => { throw rpcDown; },
      read: async () => (++reads >= 1 ? { status: "success" } : null),
    });
    const header = await livePayment(`0x${"a2".repeat(32)}`);
    const first = await merchant.requirePayment(header);
    expect(first.status === 200 && first.receipt.settlement).toBe("pending");

    const second = await merchant.requirePayment(header);
    expect(second.status === 200 && second.receipt.settlement).toBe("confirmed");
    expect(second.status === 200 && second.receipt.txHash).toBe(first.status === 200 ? first.receipt.txHash : "?");

    const third = await merchant.requirePayment(header);
    expect(third.status).toBe(402);
    expect(String(third.body?.error)).toContain("replayed authorization");
    expect(calls.broadcasts).toBe(1);
  });

  test("pending, then the receipt shows a revert → 402 and the authorization is released", async () => {
    let attempts = 0;
    const { merchant, calls } = merchantOn({
      wait: async (hash) => (++attempts === 1 ? Promise.reject(rpcDown) : { transactionHash: hash, status: "success" }),
      read: async () => ({ status: "reverted" }),
    });
    const header = await livePayment(`0x${"a3".repeat(32)}`);
    expect((await merchant.requirePayment(header)).status).toBe(200);
    const reask = await merchant.requirePayment(header);
    expect(reask.status).toBe(402);
    expect(String(reask.body?.error)).toContain("reverted");
    // Honest retry after a real failure: settles anew.
    const retry = await merchant.requirePayment(header);
    expect(retry.status === 200 && retry.receipt.settlement).toBe("confirmed");
    expect(calls.broadcasts).toBe(2);
  });

  test("pre-broadcast failure → 402 without the RPC URL, and an honest retry goes through", async () => {
    let attempts = 0;
    const revert = Object.assign(new Error("Execution reverted with reason: insufficient balance.\n\nURL: http://rpc.example/?key=SECRET"), {
      shortMessage: "Execution reverted with reason: insufficient balance.",
    });
    const { merchant, calls } = merchantOn({
      wait: async (hash) => ({ transactionHash: hash, status: "success" }),
      prepare: async (req) => { if (++attempts === 1) throw revert; return prepared(req); },
    });
    const header = await livePayment(`0x${"a4".repeat(32)}`);
    const failed = await merchant.requirePayment(header);
    expect(failed.status).toBe(402);
    expect(String(failed.body?.error)).toBe("settlement failed: Execution reverted with reason: insufficient balance.");
    expect(calls.broadcasts).toBe(0);

    const retry = await merchant.requirePayment(header);
    expect(retry.status === 200 && retry.receipt.settlement).toBe("confirmed");
    expect(calls.broadcasts).toBe(1);
  });

  test("confirmed → replay refused, as before", async () => {
    const { merchant, calls } = merchantOn({ wait: async (hash) => ({ transactionHash: hash, status: "success" }) });
    const header = await livePayment(`0x${"a5".repeat(32)}`);
    const paid = await merchant.requirePayment(header);
    expect(paid.status === 200 && paid.receipt.settlement).toBe("confirmed");
    const replay = await merchant.requirePayment(header);
    expect(replay.status).toBe(402);
    expect(String(replay.body?.error)).toContain("replayed authorization");
    expect(calls.broadcasts).toBe(1);
  });

  test("createX402Merchant needs rpcUrl or clients", () => {
    expect(() => createX402Merchant({ ...CFG, facilitator: privateKeyToAccount(generatePrivateKey()) })).toThrow(/rpcUrl or clients/);
  });
});
