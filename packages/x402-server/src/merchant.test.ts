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
