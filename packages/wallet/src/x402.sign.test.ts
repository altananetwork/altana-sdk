import { test, expect } from "bun:test";
import { size, type Address, type Hex } from "viem";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";
import { signOrderTypedData } from "./signOrder.js";
import {
  PERMIT2_ADDRESS,
  buildEip3009TypedData,
  buildPermit2TypedData,
  encodeXPaymentHeader,
  signX402Payment,
  type X402PaymentPayload,
} from "./x402.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x55d398326f99059fF775485246999027B3197955";
const PAYTO: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPENDER: Address = "0x1234567890123456789012345678901234567890";
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

function decode(header: string): X402PaymentPayload {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

test("encodeXPaymentHeader base64-round-trips the payload", () => {
  const payload: X402PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "bsc",
    payload: { hello: "world" },
  };
  expect(decode(encodeXPaymentHeader(payload))).toEqual(payload);
});

test("signX402Payment (exact/EIP-3009) builds an authorization signed over the token digest", async () => {
  const session = makeSession(createPrivateKeySigner());
  const req = {
    scheme: "exact",
    network: "bsc",
    asset: TOKEN,
    maxAmountRequired: "10000",
    payTo: PAYTO,
    maxTimeoutSeconds: 600,
    extra: { name: "USD Coin", version: "2" },
  };
  const now = 1_700_000_000;
  const { header, payload } = await signX402Payment(session, req, {
    now,
    eip3009Nonce: NONCE,
  });

  expect(payload.scheme).toBe("exact");
  const auth = (payload.payload as any).authorization;
  expect(auth.from.toLowerCase()).toBe(WALLET.toLowerCase());
  expect(auth.to.toLowerCase()).toBe(PAYTO.toLowerCase());
  expect(auth.value).toBe("10000");
  expect(auth.validBefore).toBe(String(now + 600));
  expect(auth.nonce).toBe(NONCE);
  expect(decode(header)).toEqual(payload);

  // Signature must be the account-wrapped sig over the exact EIP-3009 digest.
  const expectedSig = await signOrderTypedData(
    session,
    buildEip3009TypedData({
      chainId: 56,
      token: TOKEN,
      name: "USD Coin",
      version: "2",
      from: WALLET,
      to: PAYTO,
      value: 10_000n,
      validAfter: 0n,
      validBefore: BigInt(now + 600),
      nonce: NONCE,
    }) as any,
  );
  expect((payload.payload as any).signature).toBe(expectedSig);
});

test("signX402Payment (permit2) binds the facilitator spender and Permit2 checker", async () => {
  const session = makeSession(createPrivateKeySigner());
  const req = {
    scheme: "permit2",
    network: "bsc",
    asset: TOKEN,
    maxAmountRequired: "25000",
    payTo: PAYTO,
    maxTimeoutSeconds: 300,
    extra: { spender: SPENDER },
  };
  const now = 1_700_000_000;
  const { payload } = await signX402Payment(session, req, {
    now,
    permit2Nonce: 42n,
  });

  expect(payload.scheme).toBe("permit2");
  const permit = (payload.payload as any).permit;
  expect(permit.permitted.token.toLowerCase()).toBe(TOKEN.toLowerCase());
  expect(permit.permitted.amount).toBe("25000");
  expect(permit.spender.toLowerCase()).toBe(SPENDER.toLowerCase());
  expect(permit.deadline).toBe(String(now + 300));

  const expectedSig = await signOrderTypedData(
    session,
    buildPermit2TypedData({
      chainId: 56,
      token: TOKEN,
      amount: 25_000n,
      spender: SPENDER,
      nonce: 42n,
      deadline: BigInt(now + 300),
    }) as any,
  );
  expect((payload.payload as any).signature).toBe(expectedSig);
  // Sanity: Permit2 is the checker for this scheme.
  expect(PERMIT2_ADDRESS).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  expect(size((payload.payload as any).signature as Hex)).toBeGreaterThan(0);
});
