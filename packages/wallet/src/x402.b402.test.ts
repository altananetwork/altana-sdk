/**
 * Real Binance B402 wire compatibility.
 *
 * These requirements are captured verbatim from a live B402 402 challenge
 * (CoinMarketCap x402 DEX API, GET https://pro-api.coinmarketcap.com/x402/...):
 * every field — `scheme: "exact"`, CAIP-2 `network`, `extra.assetTransferMethod`,
 * `extra.spenderAddress`, `amount`, `x402Version: 2` — is what production sends.
 */
import { test, expect } from "bun:test";
import type { Address, Hex } from "viem";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";
import { signOrderTypedData } from "./signOrder.js";
import {
  networkToChainId,
  buildEip3009TypedData,
  buildPermit2TypedData,
  signX402Payment,
} from "./x402.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
const UNITED: Address = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const PAYTO: Address = "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA";
const SPENDER: Address = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";
const NONCE: Hex =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 0,
  };
}

// Real permit2-exact option (USDT on BNB), verbatim from the live 402.
const REAL_PERMIT2_REQ = {
  scheme: "exact",
  network: "eip155:56",
  asset: USDT,
  payTo: PAYTO,
  maxTimeoutSeconds: 30,
  extra: {
    name: "Tether USD",
    version: "1",
    assetTransferMethod: "permit2-exact",
    signerAddress: "0x34F7a661160780Ce1346e6D7B96D2bE244590899" as Address,
    spenderAddress: SPENDER,
  },
  amount: "10000000000000000",
};

// Real eip3009 option (United Stables on BNB), verbatim from the live 402.
const REAL_EIP3009_REQ = {
  scheme: "exact",
  network: "eip155:56",
  asset: UNITED,
  payTo: PAYTO,
  maxTimeoutSeconds: 30,
  extra: {
    name: "United Stables",
    version: "1",
    assetTransferMethod: "eip3009",
    signerAddress: "0x34F7a661160780Ce1346e6D7B96D2bE244590899" as Address,
  },
  amount: "10000000000000000",
};

test("signX402Payment echoes `accepted` (the chosen requirement) so the real B402 facilitator can route it", async () => {
  // Verified against the live Binance facilitator: omitting `accepted` yields
  // "Unsupported x402 payload"; including it advances to "Payment required".
  const session = makeSession(createPrivateKeySigner());
  const { payload } = await signX402Payment(
    session,
    { ...REAL_PERMIT2_REQ, x402Version: 2 },
    { now: 1_700_000_000, permit2Nonce: 42n },
  );

  const accepted = (payload as any).accepted;
  expect(accepted).toBeDefined();
  expect(accepted.asset.toLowerCase()).toBe(USDT.toLowerCase());
  expect(accepted.network).toBe("eip155:56");
  expect(accepted.payTo.toLowerCase()).toBe(PAYTO.toLowerCase());
  expect(accepted.extra.assetTransferMethod).toBe("permit2-exact");
  expect(accepted.extra.spenderAddress.toLowerCase()).toBe(SPENDER.toLowerCase());
  // The facilitator compares `accepted` to its own requirements — our injected
  // transport version must NOT leak into it.
  expect(accepted.x402Version).toBeUndefined();
});

test("networkToChainId parses CAIP-2 eip155:NN and keeps legacy names", () => {
  expect(networkToChainId("eip155:56")).toBe(56);
  expect(networkToChainId("eip155:8453")).toBe(8453);
  expect(networkToChainId("eip155:84532")).toBe(84532);
  // legacy names still resolve
  expect(networkToChainId("bsc")).toBe(56);
  expect(networkToChainId("base")).toBe(8453);
});

test("signX402Payment handles a real B402 permit2-exact requirement", async () => {
  const session = makeSession(createPrivateKeySigner());
  const now = 1_700_000_000;
  const { payload } = await signX402Payment(
    session,
    { ...REAL_PERMIT2_REQ, x402Version: 2 },
    { now, permit2Nonce: 42n },
  );

  // Echoes the real challenge's version/scheme/network.
  expect(payload.x402Version).toBe(2);
  expect(payload.scheme).toBe("exact");
  expect(payload.network).toBe("eip155:56");

  // Spec-faithful envelope: permit2 payload is {signature, from, permit} —
  // the rail is conveyed by the presence of `permit` (and the scheme), not by
  // an in-payload method field.
  const p = payload.payload as any;
  expect(p.permit).toBeDefined();
  expect(p.authorization).toBeUndefined();
  expect(p.from.toLowerCase()).toBe(WALLET.toLowerCase());
  // spender comes from extra.spenderAddress (real field name).
  expect(p.permit.spender.toLowerCase()).toBe(SPENDER.toLowerCase());
  // amount comes from `amount` (no maxAmountRequired in the real wire).
  expect(p.permit.permitted.amount).toBe("10000000000000000");
  expect(p.permit.deadline).toBe(String(now + 30));

  // Signature is the account-wrapped sig over the Permit2 digest on chain 56.
  const expectedSig = await signOrderTypedData(
    session,
    buildPermit2TypedData({
      chainId: 56,
      token: USDT,
      amount: 10_000_000_000_000_000n,
      spender: SPENDER,
      nonce: 42n,
      deadline: BigInt(now + 30),
    }) as any,
  );
  expect(p.signature).toBe(expectedSig);
});

test("signX402Payment handles a real B402 eip3009 requirement", async () => {
  const session = makeSession(createPrivateKeySigner());
  const now = 1_700_000_000;
  const { payload } = await signX402Payment(
    session,
    { ...REAL_EIP3009_REQ, x402Version: 2 },
    { now, eip3009Nonce: NONCE },
  );

  expect(payload.x402Version).toBe(2);
  expect(payload.scheme).toBe("exact");

  // Spec-faithful envelope: eip3009 payload is exactly {signature, authorization}.
  const p = payload.payload as any;
  expect(p.permit).toBeUndefined();
  const auth = p.authorization;
  expect(auth.from.toLowerCase()).toBe(WALLET.toLowerCase());
  expect(auth.to.toLowerCase()).toBe(PAYTO.toLowerCase());
  expect(auth.value).toBe("10000000000000000");
  expect(auth.validBefore).toBe(String(now + 30));
  expect(auth.nonce).toBe(NONCE);

  const expectedSig = await signOrderTypedData(
    session,
    buildEip3009TypedData({
      chainId: 56,
      token: UNITED,
      name: "United Stables",
      version: "1",
      from: WALLET,
      to: PAYTO,
      value: 10_000_000_000_000_000n,
      validAfter: 0n,
      validBefore: BigInt(now + 30),
      nonce: NONCE,
    }) as any,
  );
  expect(p.signature).toBe(expectedSig);
});
