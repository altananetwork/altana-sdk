/**
 * feeCurrencies() reads the relay's fee tokens live from
 * wallet_getCapabilities. These tests pin the wire call, the mapping of the
 * relay's answer (native relabelled from the chain config, checksummed
 * addresses, bigint rates, non-fee entries dropped, native first) and the
 * error when the relay does not serve the chain, over a mocked fetch that
 * answers by URL. The base fixture is a real testnet relay answer for Celo
 * Sepolia (captured 2026-09-15), whose native entry the relay labels "ETH".
 */
import { test, expect, afterEach, describe } from "bun:test";
import { getAddress } from "viem";
import { createClient } from "./client.js";
import { CELO_SEPOLIA, NATIVE_TOKEN, TESTNET_RELAY_URL } from "./config.js";
import { feeCurrencies, formatFeeAmount } from "./feeCurrencies.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const USDC = "0x01c5c0122039549ad1493b8220cabedd739bc44e"; // lowercase on purpose
const USDT = "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
const NOT_A_FEE_TOKEN = "0xA99dC247d6b7B2E3ab48a1fEE101b83cD6aCd82a";

/** The captured answer plus the tokens a relay pricing Celo stablecoins lists. */
function celoCapabilities() {
  const chain = structuredClone(capabilities["0xaa044c"]);
  chain.fees.tokens.push(
    { uid: "usdc", address: USDC, decimals: 6, feeToken: true, interop: false, symbol: "USDC", nativeRate: "0x94079cd1a42aaaa" },
    { uid: "usdt", address: USDT, decimals: 6, feeToken: true, interop: false, symbol: "USD₮", nativeRate: "0x94079cd1a42aaaa" },
    { uid: "eurm", address: NOT_A_FEE_TOKEN, decimals: 18, feeToken: false, interop: false, symbol: "EURm", nativeRate: "0xc83d575459003436" },
  );
  return { "0xaa044c": chain };
}

/** Answers wallet_getCapabilities at the relay URL with `result`; records the request. */
function mockRelay(result: unknown) {
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    if (url.replace(/\/$/, "") !== TESTNET_RELAY_URL) throw new Error(`unexpected fetch to ${url}`);
    if (body.method !== "wallet_getCapabilities") throw new Error(`unexpected method ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
      headers: { "content-type": "application/json" },
    });
  }) as any;
  return requests;
}

describe("feeCurrencies", () => {
  test("asks the relay for the chain and maps its fee tokens", async () => {
    const requests = mockRelay(celoCapabilities());

    const result = await feeCurrencies({ network: CELO_SEPOLIA });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.params).toEqual([["0xaa044c"]]);
    expect(result.chainId).toBe(11142220);
    expect(result.rateTtl).toBe(300);
    const nativeSymbol = CELO_SEPOLIA.chain.nativeCurrency.symbol;
    expect(result.currencies.map((c) => c.symbol)).toEqual([nativeSymbol, "USDC", "USD₮"]);

    const [native, usdc] = result.currencies;
    expect(native).toEqual({
      uid: "celo",
      address: NATIVE_TOKEN,
      symbol: nativeSymbol,
      decimals: 18,
      nativeRate: 10n ** 18n,
      isNative: true,
    });
    expect(usdc).toEqual({
      uid: "usdc",
      address: getAddress(USDC),
      symbol: "USDC",
      decimals: 6,
      nativeRate: 666666666666666666n,
      isNative: false,
    });
  });

  test("the native symbol comes from the chain config, not the relay's label", async () => {
    mockRelay(celoCapabilities());
    const result = await feeCurrencies({ network: CELO_SEPOLIA });
    expect(capabilities["0xaa044c"].fees.tokens[0]!.symbol).toBe("ETH");
    expect(result.currencies[0]!.symbol).toBe(CELO_SEPOLIA.chain.nativeCurrency.symbol);
  });

  test("a token the relay lists without a price is not an accepted fee token", async () => {
    const caps = celoCapabilities();
    const usdc = caps["0xaa044c"].fees.tokens.find((t) => t.uid === "usdc")!;
    delete (usdc as { nativeRate?: string }).nativeRate;
    mockRelay(caps);
    const result = await feeCurrencies({ network: CELO_SEPOLIA });
    expect(result.currencies.map((c) => c.uid)).toEqual(["celo", "usdt"]);
  });

  test("a relay that does not serve the chain is an error naming the relay", async () => {
    mockRelay({ "0x61": { fees: { tokens: [] } } });
    await expect(feeCurrencies({ network: CELO_SEPOLIA })).rejects.toThrow(
      /does not serve chain 11142220/,
    );
  });

  test("client.feeCurrencies resolves the chain like every other method", async () => {
    mockRelay(celoCapabilities());
    const client = createClient({ chains: [CELO_SEPOLIA] });
    const byDefault = await client.feeCurrencies();
    const byId = await client.feeCurrencies({ chainId: 11142220 });
    expect(byDefault.currencies).toHaveLength(3);
    expect(byId).toEqual(byDefault);
  });
});

describe("formatFeeAmount", () => {
  test("whole tokens with the symbol, by the token's decimals", () => {
    expect(formatFeeAmount(120_000n, { symbol: "USDC", decimals: 6 })).toBe("0.12 USDC");
    expect(formatFeeAmount(15n * 10n ** 15n, { symbol: "CELO", decimals: 18 })).toBe("0.015 CELO");
  });
});
