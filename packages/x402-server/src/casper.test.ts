import { describe, expect, it } from "bun:test";
import {
  buildCasperChallenge,
  casperEffectivePrice,
  casperPaymentPayload,
  casperPaymentRequirements,
  checkCasperPayment,
  createCasperFacilitator,
  createCasperX402Merchant,
  decodeCasperPayment,
  CASPER_MAINNET,
  CASPER_TESTNET,
  type CasperMerchantConfig,
} from "./casper.js";
import { buildChallenge } from "./challenge.js";
import { decodeXPayment } from "./decode.js";
import { U_TOKEN } from "./tokens.js";

const WCSPR_TEST = "9824d60dc3a5c44a20b9fd260a412437933835b52fc683d8ae36e4ec2114843e";
const PAY_TO = "009e5669b070545e2b32bc66363b9d3d4390fca56bf52a05f1411b7fa18ca311c7";
const PAYER = "00048a54220799a48171743407c086668bdcc788e2a31e4185fe52d0682634f888";
const PUBKEY = "0176197d7191ce519ed043221956a2227921abf30364d4362970229027ec828f04";
const NONCE = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const SIG = "a1".repeat(65);

const NOW = 1_800_000_000;

const cfg: CasperMerchantConfig = {
  network: CASPER_TESTNET,
  payTo: PAY_TO,
  price: 10_000n,
  token: { asset: WCSPR_TEST, name: "Wrapped CSPR", version: "1", symbol: "wCSPR", decimals: 9 },
  resource: "https://api.example.com/data",
};

function envelope(over: Record<string, unknown> = {}, authOver: Record<string, unknown> = {}) {
  const body = {
    x402Version: 2,
    resource: { url: "https://api.example.com/data" },
    accepted: {
      scheme: "exact",
      network: CASPER_TESTNET,
      asset: WCSPR_TEST,
      amount: "10000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    },
    payload: {
      signature: SIG,
      publicKey: PUBKEY,
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: "10000",
        validAfter: String(NOW - 60),
        validBefore: String(NOW + 300),
        nonce: NONCE,
        ...authOver,
      },
    },
    ...over,
  };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

describe("buildCasperChallenge", () => {
  it("emits an x402 v2 challenge on a casper CAIP-2 network", () => {
    const c = buildCasperChallenge(cfg);
    expect(c.x402Version).toBe(2);
    expect(c.resource).toEqual({ url: "https://api.example.com/data" });
    expect(c.accepts).toHaveLength(1);
    expect(c.accepts[0]).toEqual({
      scheme: "exact",
      network: "casper:casper-test",
      asset: WCSPR_TEST,
      payTo: PAY_TO,
      amount: "10000",
      maxTimeoutSeconds: 300,
      extra: { name: "Wrapped CSPR", version: "1", symbol: "wCSPR", decimals: "9" },
    });
  });

  it("supports mainnet and clamps the price", () => {
    const c = buildCasperChallenge({ ...cfg, network: CASPER_MAINNET, price: 1n, minPrice: 500n });
    expect(c.accepts[0]!.network).toBe("casper:casper");
    expect(c.accepts[0]!.amount).toBe("500");
    expect(casperEffectivePrice({ ...cfg, price: 10n ** 9n, maxPrice: 7n })).toBe(7n);
  });

  it("rejects a validity window the facilitator would refuse", () => {
    expect(() => buildCasperChallenge({ ...cfg, maxTimeoutSeconds: 3 })).toThrow(/at least 6/);
  });

  it("derives paymentRequirements matching the challenge entry", () => {
    expect(casperPaymentRequirements(cfg)).toEqual({
      scheme: "exact",
      network: "casper:casper-test",
      payTo: PAY_TO,
      amount: "10000",
      asset: WCSPR_TEST,
      maxTimeoutSeconds: 300,
      extra: { name: "Wrapped CSPR", version: "1", symbol: "wCSPR", decimals: "9" },
    });
  });
});

describe("decodeCasperPayment", () => {
  it("decodes a Casper payment envelope", () => {
    const d = decodeCasperPayment(envelope());
    expect(d.network).toBe("casper:casper-test");
    expect(d.payer).toBe(PAYER);
    expect(d.publicKey).toBe(PUBKEY);
    expect(d.amount).toBe(10_000n);
    expect(d.asset).toBe(WCSPR_TEST);
    expect(d.authorization.nonce).toBe(NONCE);
  });

  it("round-trips back into the facilitator paymentPayload shape", () => {
    const d = decodeCasperPayment(envelope());
    expect(casperPaymentPayload(d)).toEqual({
      x402Version: 2,
      resource: { url: "https://api.example.com/data" },
      accepted: d.accepted,
      payload: { signature: SIG, publicKey: PUBKEY, authorization: d.authorization },
    });
  });

  it("rejects non-base64, non-casper networks and malformed fields", () => {
    expect(() => decodeCasperPayment("not base64 json")).toThrow(/base64/);
    expect(() =>
      decodeCasperPayment(
        envelope({ accepted: { scheme: "exact", network: "eip155:56", asset: WCSPR_TEST } }),
      ),
    ).toThrow(/not a casper/);
    // A 20-byte EVM address is not a Casper account hash.
    expect(() =>
      decodeCasperPayment(envelope({}, { from: "0x1234567890123456789012345678901234567890" })),
    ).toThrow(/authorization.from/);
    // Nonce must be exactly 32 bytes.
    expect(() => decodeCasperPayment(envelope({}, { nonce: "dead" }))).toThrow(/authorization.nonce/);
  });
});

describe("checkCasperPayment", () => {
  const decoded = () => decodeCasperPayment(envelope());

  it("accepts a well-formed payment", () => {
    expect(checkCasperPayment(decoded(), cfg, { now: NOW })).toEqual({
      ok: true,
      payer: PAYER,
      amount: 10_000n,
      asset: WCSPR_TEST,
    });
  });

  it("rejects wrong network, asset, payee, price and expiry", () => {
    expect(checkCasperPayment(decoded(), { ...cfg, network: CASPER_MAINNET }, { now: NOW }).ok).toBe(false);
    expect(
      checkCasperPayment(decoded(), { ...cfg, network: CASPER_MAINNET }, { now: NOW }),
    ).toMatchObject({ reason: "network_mismatch" });
    expect(
      checkCasperPayment(decoded(), { ...cfg, token: { ...cfg.token, asset: "ab".repeat(32) } }, { now: NOW }),
    ).toMatchObject({ reason: "invalid_asset" });
    expect(checkCasperPayment(decoded(), { ...cfg, payTo: "00" + "ff".repeat(31) }, { now: NOW })).toMatchObject({
      reason: "pay_to_mismatch",
    });
    expect(checkCasperPayment(decoded(), { ...cfg, price: 20_000n }, { now: NOW })).toMatchObject({
      reason: "amount_mismatch",
    });
    expect(checkCasperPayment(decoded(), { ...cfg, maxPrice: 5_000n }, { now: NOW })).toMatchObject({
      reason: "amount_mismatch",
    });
    expect(checkCasperPayment(decoded(), cfg, { now: NOW + 1_000 })).toMatchObject({
      reason: "payload_expired",
    });
    expect(checkCasperPayment(decoded(), cfg, { now: NOW - 120 })).toMatchObject({
      reason: "not_yet_valid",
    });
    // Inside the window but under the facilitator's 6s floor.
    expect(checkCasperPayment(decoded(), cfg, { now: NOW + 297 })).toMatchObject({
      reason: "insufficient_time",
    });
  });
});

describe("createCasperFacilitator", () => {
  function stub(handler: (url: string, body: any) => unknown) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    const fetchStub = (async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body, headers: init.headers });
      const json = handler(String(url), body);
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchStub, calls };
  }

  it("posts the documented /verify shape and maps isValid", async () => {
    const { fetchStub, calls } = stub(() => ({ isValid: true, payer: PAYER }));
    const f = createCasperFacilitator({ fetch: fetchStub, accessToken: "token-123" });
    const res = await f.verify(decodeCasperPayment(envelope()), casperPaymentRequirements(cfg));

    expect(res).toEqual({ ok: true, payer: PAYER, amount: 10_000n, asset: WCSPR_TEST });
    expect(calls[0]!.url).toBe("https://x402-facilitator.cspr.cloud/verify");
    expect(calls[0]!.headers.authorization).toBe("token-123");
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["paymentPayload", "paymentRequirements"]);
    expect(calls[0]!.body.paymentPayload.payload.publicKey).toBe(PUBKEY);
    expect(calls[0]!.body.paymentRequirements.network).toBe("casper:casper-test");
  });

  it("surfaces invalidReason from /verify", async () => {
    const { fetchStub } = stub(() => ({
      isValid: false,
      invalidReason: "invalid_signature",
      invalidMessage: "Signature does not verify",
    }));
    const f = createCasperFacilitator({ fetch: fetchStub });
    expect(
      await f.verify(decodeCasperPayment(envelope()), casperPaymentRequirements(cfg)),
    ).toEqual({ ok: false, reason: "invalid_signature", message: "Signature does not verify" });
  });

  it("returns the deploy hash from /settle", async () => {
    const { fetchStub, calls } = stub(() => ({
      success: true,
      transaction: "88461218a5e972fcda1d764d7cc4edb2e0c3a538123b97890d484f43c55935f5",
      network: "casper:casper-test",
      payer: PAYER,
    }));
    const f = createCasperFacilitator({ fetch: fetchStub, baseUrl: "https://x402.example.com/" });
    const res = await f.settle(decodeCasperPayment(envelope()), casperPaymentRequirements(cfg));
    expect(res.transaction).toHaveLength(64);
    expect(res.payer).toBe(PAYER);
    expect(calls[0]!.url).toBe("https://x402.example.com/settle");
  });

  it("throws when /settle answers 200 with success:false", async () => {
    const { fetchStub } = stub(() => ({
      success: false,
      errorReason: "put_deploy_failed",
      errorMessage: "node rejected the deploy",
      transaction: "",
    }));
    const f = createCasperFacilitator({ fetch: fetchStub });
    await expect(
      f.settle(decodeCasperPayment(envelope()), casperPaymentRequirements(cfg)),
    ).rejects.toThrow(/put_deploy_failed: node rejected the deploy/);
  });
});

describe("createCasperX402Merchant", () => {
  function fakeFacilitator(over: Partial<Record<"verify" | "settle", any>> = {}) {
    const calls: string[] = [];
    return {
      calls,
      facilitator: {
        supported: async () => ({}),
        verify: async (...a: any[]) => {
          calls.push("verify");
          return over.verify ? over.verify(...a) : { ok: true, payer: PAYER, amount: 10_000n, asset: WCSPR_TEST };
        },
        settle: async (...a: any[]) => {
          calls.push("settle");
          return over.settle
            ? over.settle(...a)
            : { transaction: "aa".repeat(32), network: CASPER_TESTNET, payer: PAYER };
        },
      } as any,
    };
  }

  it("answers 402 with the challenge when no payment header is present", async () => {
    const { facilitator } = fakeFacilitator();
    const m = createCasperX402Merchant({ ...cfg, facilitator });
    const r = await m.requirePayment(null);
    expect(r.status).toBe(402);
    expect((r as any).body.accepts[0].network).toBe("casper:casper-test");
  });

  it("settles a valid payment and returns the deploy hash", async () => {
    const { facilitator, calls } = fakeFacilitator();
    const m = createCasperX402Merchant({ ...cfg, facilitator });
    const r = await m.requirePayment(envelopeAt(Math.floor(Date.now() / 1000)));
    expect(r.status).toBe(200);
    expect((r as any).receipt.transaction).toBe("aa".repeat(32));
    expect((r as any).receipt.amount).toBe(10_000n);
    expect(calls).toEqual(["settle"]);
  });

  it("verifies first when asked, and rejects a replayed nonce", async () => {
    const { facilitator, calls } = fakeFacilitator();
    const m = createCasperX402Merchant({ ...cfg, facilitator, verifyBeforeSettle: true });
    const live = envelopeAt(Math.floor(Date.now() / 1000));
    expect((await m.requirePayment(live)).status).toBe(200);
    expect(calls).toEqual(["verify", "settle"]);
    const replay = await m.requirePayment(live);
    expect(replay.status).toBe(402);
    expect((replay as any).body.error).toMatch(/replayed/);
  });

  it("answers 402 with the facilitator's reason when settlement fails", async () => {
    const { facilitator } = fakeFacilitator({
      settle: async () => {
        throw new Error("casper settle failed: wait_deploy_failed");
      },
    });
    const m = createCasperX402Merchant({ ...cfg, facilitator });
    const r = await m.requirePayment(envelopeAt(Math.floor(Date.now() / 1000)));
    expect(r.status).toBe(402);
    expect((r as any).body.error).toMatch(/wait_deploy_failed/);
  });

  it("guard() reads PAYMENT-SIGNATURE and answers a 402 Response", async () => {
    const { facilitator } = fakeFacilitator();
    const m = createCasperX402Merchant({ ...cfg, facilitator });
    const unpaid = await m.guard(new Request("https://api.example.com/data"));
    expect(unpaid.response?.status).toBe(402);

    const paid = await m.guard(
      new Request("https://api.example.com/data", {
        headers: { "PAYMENT-SIGNATURE": envelopeAt(Math.floor(Date.now() / 1000)) },
      }),
    );
    expect(paid.response).toBeNull();
    expect(paid.receipt?.payer).toBe(PAYER);
  });
});

describe("the EVM rails are unchanged by the Casper rail", () => {
  it("buildChallenge still emits eip155 challenges", () => {
    const c = buildChallenge({
      chainId: 56,
      payTo: "0x1111111111111111111111111111111111111111",
      price: 1_000n,
      rails: [{ rail: "eip3009", token: U_TOKEN[56] }],
    });
    expect(c.accepts[0]!.network).toBe("eip155:56");
    expect(c.accepts[0]!.extra.assetTransferMethod).toBe("eip3009");
  });

  it("decodeXPayment still rejects a Casper envelope (no EVM addresses in it)", () => {
    expect(() => decodeXPayment(envelope())).toThrow();
  });
});

/** Same fixture as `envelope()` but with the window centred on `now`. */
function envelopeAt(now: number): string {
  return envelope({}, { validAfter: String(now - 60), validBefore: String(now + 300) });
}
