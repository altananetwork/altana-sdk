import { test, expect, afterEach } from "bun:test";
import type { Address } from "viem";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";
import { fetchWithX402 } from "./x402.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x55d398326f99059fF775485246999027B3197955";
const PAYTO: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 0,
  };
}

test("fetchWithX402 pays a 402 and retries with an X-PAYMENT header", async () => {
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "bsc",
              asset: TOKEN,
              maxAmountRequired: "10000",
              payTo: PAYTO,
              maxTimeoutSeconds: 600,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://api.example.com/resource");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("paid-content");

  expect(calls.length).toBe(2);
  const retryHeaders = new Headers(calls[1]!.init!.headers);
  const xPayment = retryHeaders.get("X-PAYMENT");
  expect(xPayment).toBeTruthy();
  const decoded = JSON.parse(Buffer.from(xPayment!, "base64").toString("utf8"));
  expect(decoded.scheme).toBe("exact");
  expect(decoded.payload.authorization.from.toLowerCase()).toBe(
    WALLET.toLowerCase(),
  );
});

test("fetchWithX402 picks BNB permit2-exact from a real multi-option B402 402", async () => {
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  // Real B402 shape: many `accepts`, all scheme "exact"; the rail is in
  // extra.assetTransferMethod. Base-USDC/eip3009 is listed FIRST, but a smart
  // wallet on BNB (56) should pay via the BNB permit2-exact USDT option.
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              payTo: PAYTO,
              maxTimeoutSeconds: 30,
              extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
              amount: "10000",
            },
            {
              scheme: "exact",
              network: "eip155:56",
              asset: TOKEN,
              payTo: PAYTO,
              maxTimeoutSeconds: 30,
              extra: {
                name: "Tether USD",
                version: "1",
                assetTransferMethod: "permit2-exact",
                spenderAddress: "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633",
              },
              amount: "10000000000000000",
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://pro-api.example.com/x402", undefined, {
    chainId: 56,
  });
  expect(res.status).toBe(200);

  const retryHeaders = new Headers(calls[1]!.init!.headers);
  const decoded = JSON.parse(
    Buffer.from(retryHeaders.get("X-PAYMENT")!, "base64").toString("utf8"),
  );
  expect(decoded.x402Version).toBe(2);
  expect(decoded.network).toBe("eip155:56");
  // Chose the permit2 rail (has a `permit`, not an eip3009 `authorization`).
  expect(decoded.payload.permit).toBeDefined();
  expect(decoded.payload.permit.permitted.token.toLowerCase()).toBe(TOKEN.toLowerCase());
});

test("fetchWithX402 passes non-402 responses through untouched", async () => {
  const session = makeSession(createPrivateKeySigner());
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://api.example.com/free");
  expect(res.status).toBe(200);
  expect(count).toBe(1); // no retry
});
