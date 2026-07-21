/**
 * client.balances must forward the `tokens` option to the standalone impl.
 * Omitting `tokens` must keep the result shape unchanged (no `tokens` key) so
 * existing consumers of { native } see no difference; an explicit empty array
 * must produce `tokens: []` without any token RPC traffic.
 */
import { test, expect, afterEach } from "bun:test";

console.error("[probe] client.balances.test.ts module loaded");
import type { Address } from "viem";
import { createClient } from "./client.js";
import { BNB } from "./config.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers eth_getBalance over JSON-RPC; anything else fails the test. */
function mockRpc(balanceHex: string): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string }) => {
      calls.push(req.method);
      if (req.method !== "eth_getBalance") {
        throw new Error(`unexpected RPC method: ${req.method}`);
      }
      return { jsonrpc: "2.0", id: req.id, result: balanceHex };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
    });
  }) as typeof fetch;
  return { calls };
}

test("omitting tokens keeps the legacy shape: only native, no tokens key", async () => {
  console.error("[probe] first balances test body entered");
  const { calls } = mockRpc("0xde0b6b3a7640000"); // 1e18
  const client = createClient({ chains: [BNB] });
  console.error("[probe] createClient returned, awaiting balances");
  const res = await client.balances({ wallet: WALLET });
  expect(res.native).toBe(10n ** 18n);
  expect("tokens" in res).toBe(false);
  expect(calls).toEqual(["eth_getBalance"]);
});

test("tokens: [] is forwarded and yields tokens: [] with no token RPC traffic", async () => {
  const { calls } = mockRpc("0x0");
  const client = createClient({ chains: [BNB] });
  const res = await client.balances({ wallet: WALLET, tokens: [] });
  expect(res.native).toBe(0n);
  expect(res.tokens).toEqual([]);
  expect(calls).toEqual(["eth_getBalance"]);
});
