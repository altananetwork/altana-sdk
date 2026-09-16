/**
 * The fee token rule on the wire: what `wallet_prepareCalls` actually carries
 * in `capabilities.meta.feeToken` after porto has built the request, over a
 * mocked fetch that plays the relay (capabilities from a real testnet
 * answer, a captured prepareCalls answer, a send) and the public RPC
 * (balances). porto fills a blank fee token from a session key's first spend
 * cap, so these assert the request porto sends, not the SDK's own object.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  slice,
  type Address,
  type Hex,
} from "viem";
import { BNB, CELO_SEPOLIA, NATIVE_TOKEN, type NetworkConfig } from "../config.js";
import { createPrivateKeySigner } from "./signer.js";
import { submitCallsDetailed, type KeyDescriptor } from "./relay.js";
import capabilities from "./fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const USDM: Address = "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";
const USDT_BNB: Address = "0x55d398326f99059fF775485246999027B3197955";
const CALLS = [{ to: WALLET, value: 0n, data: "0x" as Hex }];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const feeToken = (uid: string, address: Address, decimals: number, symbol: string) => ({
  uid, address, decimals, feeToken: true, interop: false, symbol, nativeRate: "0x94079cd1a42aaaa",
});

/** The captured chain capabilities under `chainId`, with `extraTokens` listed as fee tokens. */
function chainCapabilities(chainId: number, extraTokens: ReturnType<typeof feeToken>[]) {
  const chain = structuredClone(capabilities["0xaa044c"]);
  chain.fees.tokens.push(...extraTokens);
  return { [numberToHex(chainId)]: chain };
}

const SEL = { getCurrentBlockTimestamp: "0x0f28c97d", balanceOf: "0x70a08231", decimals: "0x313ce567", symbol: "0x95d89b41" } as const;
const uint = (n: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]);
const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);

/** Answers one aggregate3 from `tokens` (raw balance by lowercase address). */
function answerAggregate3(data: Hex, tokens: Record<string, bigint>): Hex {
  const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
  if (functionName !== "aggregate3") throw new Error(`unexpected multicall fn ${functionName}`);
  const calls = args[0] as readonly { target: Address; callData: Hex }[];
  const results = calls.map(({ target, callData }) => {
    const selector = slice(callData, 0, 4);
    if (selector === SEL.getCurrentBlockTimestamp) return { success: true, returnData: uint(1_800_000_000n) };
    const raw = tokens[target.toLowerCase()];
    if (raw === undefined) return { success: false, returnData: "0x" as Hex };
    if (selector === SEL.balanceOf) return { success: true, returnData: uint(raw) };
    if (selector === SEL.decimals) return { success: true, returnData: uint(18) };
    if (selector === SEL.symbol) return { success: true, returnData: str("TOK") };
    return { success: false, returnData: "0x" as Hex };
  });
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}

type Recorded = { method: string; params: any };

/** Plays the relay and the public RPC for `network`. Returns what the relay received. */
function mockWire(o: {
  network: NetworkConfig;
  capabilities: unknown;
  native: bigint;
  tokens: Record<string, bigint>;
}) {
  const relayCalls: Recorded[] = [];
  const same = (a: string, b: string | undefined) =>
    b !== undefined && a.replace(/\/$/, "") === b.replace(/\/$/, "");
  const tokens = Object.fromEntries(Object.entries(o.tokens).map(([k, v]) => [k.toLowerCase(), v]));
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      if (same(u, o.network.relayUrl)) {
        relayCalls.push({ method: req.method, params: req.params });
        if (req.method === "wallet_getCapabilities") return { jsonrpc: "2.0", id: req.id, result: o.capabilities };
        if (req.method === "wallet_prepareCalls") return { jsonrpc: "2.0", id: req.id, result: prepared };
        if (req.method === "wallet_sendPreparedCalls") return { jsonrpc: "2.0", id: req.id, result: { id: "0xabc" } };
        throw new Error(`relay got ${req.method}`);
      }
      if (same(u, o.network.publicRpcUrl)) {
        if (req.method === "eth_call") {
          const [{ data }] = req.params as [{ to: Address; data: Hex }];
          return { jsonrpc: "2.0", id: req.id, result: answerAggregate3(data, tokens) };
        }
        if (req.method === "eth_getBalance") return { jsonrpc: "2.0", id: req.id, result: numberToHex(o.native) };
        throw new Error(`public rpc got ${req.method}`);
      }
      throw new Error(`unexpected URL ${u}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return {
    relayCalls,
    wireFeeToken: () => {
      const prepare = relayCalls.find((c) => c.method === "wallet_prepareCalls");
      if (!prepare) throw new Error("no wallet_prepareCalls reached the relay");
      return prepare.params[0].capabilities.meta.feeToken as string | undefined;
    },
  };
}

function sessionKey(signer: ReturnType<typeof createPrivateKeySigner>, spend: { token?: Address }[]): KeyDescriptor {
  return {
    type: "secp256k1",
    publicKey: signer.publicKey,
    role: "session",
    expiry: 4102444800,
    permissions: {
      calls: [{ to: WALLET }],
      spend: spend.map((s) => ({ limit: 10n ** 18n, period: "day" as const, ...(s.token ? { token: s.token } : {}) })),
    },
  };
}

describe("fee token on the wire", () => {
  test("session on BNB with a USDT cap, wallet holds BNB: the request names native", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: BNB,
      capabilities: chainCapabilities(BNB.chainId, []),
      native: 10n ** 18n,
      tokens: { [USDT_BNB]: 50n * 10n ** 18n },
    });
    const result = await submitCallsDetailed(relayClientFor(BNB), WALLET, signer, CALLS, {
      submittingKey: sessionKey(signer, [{ token: USDT_BNB }, {}]),
      network: BNB,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(NATIVE_TOKEN);
    expect(result.callsId).toBe("0xabc");
  });

  test("session on Celo Sepolia with a USDC cap, wallet holds only USDC: the request names USDC", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      native: 0n,
      tokens: { [USDC]: 3_000_000n },
    });
    await submitCallsDetailed(relayClientFor(CELO_SEPOLIA), WALLET, signer, CALLS, {
      submittingKey: sessionKey(signer, [{}, { token: USDC }]),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(USDC.toLowerCase());
  });

  test("session whose wallet holds none of its cap tokens: throws before the relay is asked to prepare", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      native: 0n,
      tokens: { [USDC]: 0n },
    });
    await expect(
      submitCallsDetailed(relayClientFor(CELO_SEPOLIA), WALLET, signer, CALLS, {
        submittingKey: sessionKey(signer, [{}, { token: USDC }]),
        network: CELO_SEPOLIA,
      }),
    ).rejects.toThrow(/holds none of the tokens it could pay the relay fee with .* accepts S-CELO, USDC/);
    expect(wire.relayCalls.map((c) => c.method)).toEqual(["wallet_getCapabilities"]);
  });

  test("feeTokens: the first accepted and held token of the list is named", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC"), feeToken("usdm", USDM, 18, "USDm")]),
      native: 0n,
      tokens: { [USDM]: 0n, [USDC]: 10n ** 12n },
    });
    await submitCallsDetailed(relayClientFor(CELO_SEPOLIA), WALLET, signer, CALLS, {
      feeTokens: [USDT_BNB, USDM, USDC],
      submittingKey: { type: "secp256k1", publicKey: signer.publicKey, role: "admin" },
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(USDC.toLowerCase());
  });

  test("feeTokens with nothing that qualifies: throws before the relay is asked to prepare", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      native: 5n,
      tokens: {},
    });
    await expect(
      submitCallsDetailed(relayClientFor(CELO_SEPOLIA), WALLET, signer, CALLS, {
        feeTokens: [USDT_BNB],
        submittingKey: { type: "secp256k1", publicKey: signer.publicKey, role: "admin" },
        network: CELO_SEPOLIA,
      }),
    ).rejects.toThrow(/named in `feeTokens` .* is a fee token the relay accepts/);
    expect(wire.relayCalls.map((c) => c.method)).toEqual(["wallet_getCapabilities"]);
  });

  test("wallet key with nothing named: no fee token on the wire, the relay picks", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      native: 0n,
      tokens: {},
    });
    await submitCallsDetailed(relayClientFor(CELO_SEPOLIA), WALLET, signer, CALLS, {
      submittingKey: { type: "secp256k1", publicKey: signer.publicKey, role: "admin" },
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()).toBeUndefined();
    // No balance lookup either: the relay decides.
    expect(wire.relayCalls.filter((c) => c.method === "wallet_getCapabilities").length).toBe(1);
  });

  test("feeToken named: sent as is, for a session too", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      native: 0n,
      tokens: {},
    });
    await submitCallsDetailed(relayClientFor(CELO_SEPOLIA), WALLET, signer, CALLS, {
      feeToken: NATIVE_TOKEN,
      submittingKey: sessionKey(signer, [{ token: USDC }]),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(NATIVE_TOKEN);
  });
});

import { buildRelayClient } from "./relay.js";
function relayClientFor(network: NetworkConfig) {
  return buildRelayClient(network);
}
