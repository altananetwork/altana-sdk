/**
 * The fee token rule on the wire: what `wallet_prepareCalls` actually carries
 * in `capabilities.meta.feeToken` after porto has built the request, over a
 * mocked fetch that plays the relay (capabilities from a real testnet
 * answer, `wallet_getAssets` balances, a captured prepareCalls answer, a
 * send). porto fills a blank fee token from a session key's first spend cap,
 * so these assert the request porto sends, not the SDK's own object. The
 * balances the picker uses are the relay's; no public RPC is contacted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address, type Hex } from "viem";
import { BNB, CELO_SEPOLIA, NATIVE_TOKEN, type NetworkConfig } from "../config.js";
import { createPrivateKeySigner } from "./signer.js";
import { buildRelayClient, submitCallsDetailed, type KeyDescriptor } from "./relay.js";
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

/** An ERC-7811 `wallet_getAssets` answer for one chain (lowercase ERC-20 addresses on purpose). */
function assetsAnswer(chainId: number, native: bigint, tokens: Record<string, bigint>) {
  return {
    [numberToHex(chainId)]: [
      { address: "native", balance: numberToHex(native), type: "native", metadata: null },
      ...Object.entries(tokens).map(([address, raw]) => ({
        address: address.toLowerCase(),
        balance: numberToHex(raw),
        type: "erc20",
        metadata: { symbol: "X", decimals: 18 },
      })),
    ],
  };
}

type Recorded = { url: string; method: string; params: any };

/** Plays the relay for `network` and refuses everything else. Returns every request made. */
function mockWire(o: { network: NetworkConfig; capabilities: unknown; assets: unknown }) {
  const requests: Recorded[] = [];
  const same = (a: string, b: string | undefined) =>
    b !== undefined && a.replace(/\/$/, "") === b.replace(/\/$/, "");
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      requests.push({ url: u, method: req.method, params: req.params });
      if (!same(u, o.network.relayUrl)) throw new Error(`unexpected request to ${u}: ${req.method}`);
      if (req.method === "wallet_getCapabilities") return { jsonrpc: "2.0", id: req.id, result: o.capabilities };
      if (req.method === "wallet_getAssets") return { jsonrpc: "2.0", id: req.id, result: o.assets };
      if (req.method === "wallet_prepareCalls") return { jsonrpc: "2.0", id: req.id, result: prepared };
      if (req.method === "wallet_sendPreparedCalls") return { jsonrpc: "2.0", id: req.id, result: { id: "0xabc" } };
      throw new Error(`relay got ${req.method}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return {
    requests,
    methods: () => requests.map((r) => r.method),
    publicRpcRequests: () => requests.filter((r) => same(r.url, o.network.publicRpcUrl)),
    wireFeeToken: () => {
      const prepare = requests.find((c) => c.method === "wallet_prepareCalls");
      if (!prepare) throw new Error("no wallet_prepareCalls reached the relay");
      return prepare.params[0].capabilities.meta.feeToken as string | undefined;
    },
    assetsRequest: () => requests.find((c) => c.method === "wallet_getAssets")?.params[0],
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

const adminKey = (signer: ReturnType<typeof createPrivateKeySigner>): KeyDescriptor => ({
  type: "secp256k1",
  publicKey: signer.publicKey,
  role: "admin",
});

describe("fee token on the wire", () => {
  test("session on BNB with a USDT cap, wallet holds BNB: the request names native", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: BNB,
      capabilities: chainCapabilities(BNB.chainId, []),
      assets: assetsAnswer(BNB.chainId, 10n ** 18n, { [USDT_BNB]: 50n * 10n ** 18n }),
    });
    const result = await submitCallsDetailed(buildRelayClient(BNB), WALLET, signer, CALLS, {
      submittingKey: sessionKey(signer, [{ token: USDT_BNB }, {}]),
      network: BNB,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(NATIVE_TOKEN);
    expect(result.callsId).toBe("0xabc");
    expect(wire.publicRpcRequests()).toEqual([]);
  });

  test("session on Celo Sepolia with a USDC cap, wallet holds only USDC: the request names USDC, balances from the relay", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, { [USDC]: 3_000_000n }),
    });
    await submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
      submittingKey: sessionKey(signer, [{}, { token: USDC }]),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(wire.assetsRequest()).toEqual({
      account: WALLET,
      assetTypeFilter: ["native", "erc20"],
      chainFilter: [numberToHex(CELO_SEPOLIA.chainId)],
    });
    expect(wire.publicRpcRequests()).toEqual([]);
    // Everything the send needed came from the relay, in this order.
    expect(wire.methods()).toEqual([
      "wallet_getCapabilities", // the picker's accepted list
      "wallet_getAssets", // the picker's balances
      "wallet_getCapabilities", // porto's own, inside prepareCalls
      "wallet_prepareCalls",
      "wallet_sendPreparedCalls",
    ]);
  });

  test("session whose wallet holds none of its cap tokens: throws before the relay is asked to prepare", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, { [USDC]: 0n }),
    });
    await expect(
      submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
        submittingKey: sessionKey(signer, [{}, { token: USDC }]),
        network: CELO_SEPOLIA,
      }),
    ).rejects.toThrow(/holds none of the tokens it could pay the relay fee with .* accepts S-CELO, USDC/);
    expect(wire.methods()).toEqual(["wallet_getCapabilities", "wallet_getAssets"]);
    expect(wire.publicRpcRequests()).toEqual([]);
  });

  test("a token the relay does not list in wallet_getAssets counts as not held", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC"), feeToken("usdm", USDM, 18, "USDm")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, { [USDM]: 7n }),
    });
    await submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
      submittingKey: sessionKey(signer, [{ token: USDC }, { token: USDM }]),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(USDM.toLowerCase());
  });

  test("feeToken list: the first accepted and held token of the list is named", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC"), feeToken("usdm", USDM, 18, "USDm")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, { [USDM]: 0n, [USDC]: 10n ** 12n }),
    });
    await submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
      feeToken: [USDT_BNB, USDM, USDC],
      submittingKey: adminKey(signer),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(wire.publicRpcRequests()).toEqual([]);
  });

  test("feeToken list with nothing that qualifies: throws before the relay is asked to prepare", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 5n, {}),
    });
    await expect(
      submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
        feeToken: [USDT_BNB],
        submittingKey: adminKey(signer),
        network: CELO_SEPOLIA,
      }),
    ).rejects.toThrow(/named in `feeToken` .* is a fee token the relay accepts/);
    expect(wire.methods()).toEqual(["wallet_getCapabilities"]);
  });

  test("feeToken: [] names nothing, so the session rule applies", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, { [USDC]: 3_000_000n }),
    });
    await submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
      feeToken: [],
      submittingKey: sessionKey(signer, [{ token: USDC }]),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(USDC.toLowerCase());
  });

  test("wallet key with nothing named: no fee token on the wire, the relay picks", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, {}),
    });
    await submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
      submittingKey: adminKey(signer),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()).toBeUndefined();
    // No balance lookup either: the relay decides.
    expect(wire.methods()).toEqual(["wallet_getCapabilities", "wallet_prepareCalls", "wallet_sendPreparedCalls"]);
  });

  test("feeToken named: sent as is, for a session too", async () => {
    const signer = createPrivateKeySigner();
    const wire = mockWire({
      network: CELO_SEPOLIA,
      capabilities: chainCapabilities(CELO_SEPOLIA.chainId, [feeToken("usdc", USDC, 6, "USDC")]),
      assets: assetsAnswer(CELO_SEPOLIA.chainId, 0n, {}),
    });
    await submitCallsDetailed(buildRelayClient(CELO_SEPOLIA), WALLET, signer, CALLS, {
      feeToken: NATIVE_TOKEN,
      submittingKey: sessionKey(signer, [{ token: USDC }]),
      network: CELO_SEPOLIA,
    });
    expect(wire.wireFeeToken()?.toLowerCase()).toBe(NATIVE_TOKEN);
    expect(wire.methods()).toEqual(["wallet_getCapabilities", "wallet_prepareCalls", "wallet_sendPreparedCalls"]);
  });
});
