/**
 * client.holdings asks the relay which tokens the wallet holds
 * (wallet_getAssets) and then reads them live through the public RPC. These
 * tests pin the wire shape sent to the relay, the mapping of its answer, the
 * zero filter, and the error messages — all over a mocked fetch that tells
 * the relay URL and the public RPC URL apart by URL.
 */
import { test, expect, afterEach } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  multicall3Abi,
  numberToHex,
  slice,
  type Address,
  type Hex,
} from "viem";
import { createClient } from "./client.js";
import { BNB, RELAY_URL, type NetworkConfig } from "./config.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
const SPCXB: Address = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
const DEAD: Address = "0xdEaD000000000000000000000000000000000000";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type TokenSpec = { raw: bigint; decimals?: number; symbol?: string; broken?: boolean };

/** Selectors of the calls readTokenBalances issues per token, plus the header. */
const SEL = {
  getCurrentBlockTimestamp: "0x0f28c97d",
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
} as const;

const uint = (n: bigint | number) =>
  encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]);
const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);

/** Answers one aggregate3 by looking each inner call up in `tokens`. */
function answerAggregate3(data: Hex, tokens: Record<string, TokenSpec>): Hex {
  const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
  if (functionName !== "aggregate3") throw new Error(`unexpected multicall fn ${functionName}`);
  const calls = args[0] as readonly { target: Address; callData: Hex }[];
  const results = calls.map(({ target, callData }) => {
    const selector = slice(callData, 0, 4);
    if (selector === SEL.getCurrentBlockTimestamp) {
      return { success: true, returnData: uint(1_800_000_000n) };
    }
    const spec = tokens[target.toLowerCase()];
    if (!spec || spec.broken) return { success: false, returnData: "0x" as Hex };
    if (selector === SEL.balanceOf) return { success: true, returnData: uint(spec.raw) };
    if (selector === SEL.decimals) return { success: true, returnData: uint(spec.decimals ?? 18) };
    if (selector === SEL.symbol) return { success: true, returnData: str(spec.symbol ?? "TOK") };
    return { success: false, returnData: "0x" as Hex };
  });
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}

type Recorded = { url: string; method: string; params: unknown };

/**
 * Mocks fetch for both endpoints. `relay` is either the JSON-RPC result the
 * relay returns for wallet_getAssets or `{ error }` to make it fail.
 */
function mockNetwork(o: {
  relay: unknown | { error: { code: number; message: string } };
  tokens?: Record<string, TokenSpec>;
  nativeOnChain?: bigint;
  network?: NetworkConfig;
}) {
  const network = o.network ?? BNB;
  const tokens = Object.fromEntries(
    Object.entries(o.tokens ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const calls: Recorded[] = [];
  const same = (a: string, b: string | undefined) =>
    b !== undefined && a.replace(/\/$/, "") === b.replace(/\/$/, "");
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url).replace(/\/$/, "");
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: unknown }) => {
      calls.push({ url: u, method: req.method, params: req.params });
      if (same(u, network.relayUrl)) {
        if (req.method !== "wallet_getAssets") throw new Error(`relay got ${req.method}`);
        const r = o.relay as any;
        if (r && typeof r === "object" && "error" in r && r.error && !Array.isArray(r)) {
          return { jsonrpc: "2.0", id: req.id, error: r.error };
        }
        return { jsonrpc: "2.0", id: req.id, result: o.relay };
      }
      if (same(u, network.publicRpcUrl)) {
        if (req.method === "eth_call") {
          const [{ data }] = req.params as [{ to: Address; data: Hex }];
          return { jsonrpc: "2.0", id: req.id, result: answerAggregate3(data, tokens) };
        }
        if (req.method === "eth_getBalance") {
          return { jsonrpc: "2.0", id: req.id, result: numberToHex(o.nativeOnChain ?? 0n) };
        }
        throw new Error(`public rpc got ${req.method}`);
      }
      throw new Error(`unexpected URL ${u}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

const asset = (address: string, balance: bigint, type = "erc20") => ({
  address,
  balance: numberToHex(balance),
  type,
  metadata: { symbol: "X", decimals: 18 },
});
const nativeAsset = (balance: bigint) => ({
  address: "native",
  balance: numberToHex(balance),
  type: "native",
  metadata: null,
});

test("sends wallet_getAssets to the relay in the ERC-7811 shape and multicall to the public RPC", async () => {
  const { calls } = mockNetwork({
    relay: { "0x38": [nativeAsset(5n), asset(USDT, 1n)] },
    tokens: { [USDT]: { raw: 7n * 10n ** 18n, symbol: "USDT" } },
  });
  const client = createClient({ chains: [BNB] });
  const res = await client.holdings({ wallet: WALLET });

  const relayCalls = calls.filter((c) => c.url === RELAY_URL);
  expect(relayCalls.map((c) => c.method)).toEqual(["wallet_getAssets"]);
  expect(relayCalls[0]!.params).toEqual([
    { account: WALLET, assetTypeFilter: ["native", "erc20"], chainFilter: ["0x38"] },
  ]);
  const rpcCalls = calls.filter((c) => c.url === BNB.publicRpcUrl);
  expect(rpcCalls.map((c) => c.method)).toEqual(["eth_call"]);

  expect(res.native).toBe(5n);
  expect(res.tokens).toHaveLength(1);
  const t = res.tokens[0]!;
  if (!t.ok) throw new Error(t.error);
  expect(t.address).toBe(USDT);
  expect(t.raw).toBe(7n * 10n ** 18n);
  expect(t.symbol).toBe("USDT");
  expect(t.display).toBe("7");
});

test("maps every erc20 the relay lists, dedupes by lowercase address, ignores non-erc20 types", async () => {
  const { calls } = mockNetwork({
    relay: {
      "0x38": [
        nativeAsset(1n),
        asset(USDT.toLowerCase(), 1n),
        asset(USDT, 1n), // duplicate in a different case
        asset(SPCXB, 1n),
        asset("0x2222222222222222222222222222222222222222", 1n, "erc721"),
      ],
    },
    tokens: {
      [USDT]: { raw: 10n, decimals: 6, symbol: "USDT" },
      [SPCXB]: { raw: 20n, decimals: 6, symbol: "SPCXB" },
    },
  });
  const client = createClient({ chains: [BNB] });
  const res = await client.holdings({ wallet: WALLET });
  expect(res.tokens.map((t) => t.address.toLowerCase())).toEqual([
    USDT.toLowerCase(),
    SPCXB.toLowerCase(),
  ]);
  // One multicall, no getBalance (native came from the relay).
  expect(calls.filter((c) => c.url === BNB.publicRpcUrl).map((c) => c.method)).toEqual(["eth_call"]);
});

test("drops zero balances by default, keeps them with includeZero, always keeps ok:false", async () => {
  const relay = { "0x38": [nativeAsset(0n), asset(USDT, 0n), asset(SPCXB, 1n), asset(DEAD, 1n)] };
  const tokens = {
    [USDT]: { raw: 0n, symbol: "USDT" },
    [SPCXB]: { raw: 3n, symbol: "SPCXB" },
    [DEAD]: { raw: 0n, broken: true },
  };
  const client = createClient({ chains: [BNB] });

  mockNetwork({ relay, tokens });
  const filtered = await client.holdings({ wallet: WALLET });
  // Addresses come back checksummed regardless of how the relay cased them.
  expect(filtered.tokens.map((t) => [t.address, t.ok])).toEqual([
    [getAddress(SPCXB), true],
    [getAddress(DEAD), false],
  ]);
  const broken = filtered.tokens[1]!;
  if (broken.ok) throw new Error("expected ok:false");
  expect(broken.error).toContain("balanceOf");

  mockNetwork({ relay, tokens });
  const all = await client.holdings({ wallet: WALLET, includeZero: true });
  expect(all.tokens.map((t) => t.address)).toEqual([USDT, SPCXB, DEAD].map((a) => getAddress(a)));
});

test("native falls back to eth_getBalance when the relay omits the native entry", async () => {
  const { calls } = mockNetwork({
    relay: { "0x38": [asset(USDT, 1n)] },
    tokens: { [USDT]: { raw: 1n } },
    nativeOnChain: 42n,
  });
  const client = createClient({ chains: [BNB] });
  const res = await client.holdings({ wallet: WALLET });
  expect(res.native).toBe(42n);
  const methods = calls.filter((c) => c.url === BNB.publicRpcUrl).map((c) => c.method).sort();
  expect(methods).toEqual(["eth_call", "eth_getBalance"]);
});

test("a chain the relay did not include yields native from chain and no tokens", async () => {
  const { calls } = mockNetwork({ relay: {}, nativeOnChain: 9n });
  const client = createClient({ chains: [BNB] });
  const res = await client.holdings({ wallet: WALLET });
  expect(res).toEqual({ native: 9n, tokens: [] });
  expect(calls.filter((c) => c.url === BNB.publicRpcUrl).map((c) => c.method)).toEqual(["eth_getBalance"]);
});

test("accepts a Wallet object and a decimal chain key", async () => {
  mockNetwork({ relay: { "56": [nativeAsset(11n)] } });
  const client = createClient({ chains: [BNB] });
  const res = await client.holdings({ wallet: { address: WALLET } as any });
  expect(res.native).toBe(11n);
  expect(res.tokens).toEqual([]);
});

test("a relay error becomes a descriptive Error with the original on .cause", async () => {
  mockNetwork({ relay: { error: { code: -32000, message: "account not found" } } });
  const client = createClient({ chains: [BNB] });
  let caught: unknown;
  try {
    await client.holdings({ wallet: WALLET });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  const err = caught as Error;
  expect(err.message).toBe(
    `The relay could not list holdings for ${WALLET} on chain 56: account not found`,
  );
  expect(err.cause).toBeDefined();
});

test("a malformed relay response is rejected with a specific message", async () => {
  const client = createClient({ chains: [BNB] });
  const cases: [unknown, string][] = [
    [[1, 2], "expected an object keyed by chain id"],
    ["nope", "expected an object keyed by chain id"],
    [{ "0x38": { address: "native" } }, "entry for chain 56 is not an array"],
    [{ "0x38": [{ address: "native", balance: "0x1", type: "gold" }] }, 'asset #0 has unknown type "gold"'],
    [{ "0x38": [{ address: "0x1234", balance: "0x1", type: "erc20" }] }, 'asset #0 has an invalid address "0x1234"'],
    [{ "0x38": [{ address: "native", balance: 5, type: "native" }] }, "asset #0 has a non-hex balance 5"],
    [{ bnb: [] }, 'chain key "bnb" is not a number'],
  ];
  for (const [relay, detail] of cases) {
    mockNetwork({ relay });
    await expect(client.holdings({ wallet: WALLET })).rejects.toThrow(
      `The relay returned a malformed wallet_getAssets response for ${WALLET} on chain 56: ${detail}`,
    );
  }
});

test("a chain without a relay throws before any network call", async () => {
  const { relayUrl: _drop, ...noRelay } = BNB;
  const { calls } = mockNetwork({ relay: {}, network: noRelay });
  const client = createClient({ chains: [noRelay] });
  await expect(client.holdings({ wallet: WALLET })).rejects.toThrow(
    /No Altana relay serves chain 56/,
  );
  expect(calls).toEqual([]);
});
