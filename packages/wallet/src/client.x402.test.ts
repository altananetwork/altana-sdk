/**
 * client.fetchWithX402 must forward chain/rail selection to the standalone.
 * The client is chain-aware, so it should default the x402 chainId to its own
 * defaultChainId (and honor an explicit override) — otherwise it can pay on the
 * wrong chain when a 402 offers the same rail on several chains.
 */
import { test, expect, afterEach } from "bun:test";
import type { Address } from "viem";
import { createClient } from "./client.js";
import { BNB } from "./config.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const PAYTO: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE_TOKEN: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BNB_TOKEN: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const SPENDER: Address = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";

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

/** A 402 offering the SAME permit2-exact rail on Base (first) and BNB (second). */
function mock402(): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  const opt = (network: string, asset: Address) => ({
    scheme: "exact",
    network,
    asset,
    payTo: PAYTO,
    maxTimeoutSeconds: 30,
    extra: { name: "USD Coin", version: "1", assetTransferMethod: "permit2-exact", spenderAddress: SPENDER },
    amount: "10000000000000000",
  });
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          // Base listed FIRST so a chain-blind selector would pay on Base.
          accepts: [opt("eip155:8453", BASE_TOKEN), opt("eip155:56", BNB_TOKEN)],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;
  return calls;
}

function decodeXPayment(calls: { init?: RequestInit }[]): any {
  const headers = new Headers(calls[1]!.init!.headers);
  return JSON.parse(Buffer.from(headers.get("X-PAYMENT")!, "base64").toString("utf8"));
}

test("client.fetchWithX402 defaults the x402 chainId to the client's defaultChainId", async () => {
  const client = createClient({ chains: [BNB] }); // defaultChainId = 56
  const session = makeSession(createPrivateKeySigner());
  const calls = mock402();

  const res = await client.fetchWithX402({ session, url: "https://api.example.com/x402" });
  expect(res.status).toBe(200);

  const decoded = decodeXPayment(calls);
  // Must pay on BNB (the client's chain), NOT the first-listed Base option.
  expect(decoded.network).toBe("eip155:56");
  expect(decoded.accepted.asset.toLowerCase()).toBe(BNB_TOKEN.toLowerCase());
});

test("client.fetchWithX402 honors an explicit chainId override", async () => {
  const client = createClient({ chains: [BNB] });
  const session = makeSession(createPrivateKeySigner());
  const calls = mock402();

  const res = await client.fetchWithX402({
    session,
    url: "https://api.example.com/x402",
    chainId: 8453,
  });
  expect(res.status).toBe(200);

  const decoded = decodeXPayment(calls);
  expect(decoded.network).toBe("eip155:8453");
  expect(decoded.accepted.asset.toLowerCase()).toBe(BASE_TOKEN.toLowerCase());
});
