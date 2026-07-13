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
