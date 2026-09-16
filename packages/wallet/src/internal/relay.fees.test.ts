/**
 * Who picks the relay's fee token.
 *
 * With no `feeToken` the prepare request carries none, so the relay charges
 * the accepted token the wallet holds. What it charged is read back from the
 * intent the relay quoted, not echoed from the request. The prepare fixture is
 * a real testnet relay answer for Celo Sepolia (captured 2026-09-15).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { getAddress, type Address } from "viem";
import { CELO_SEPOLIA, NATIVE_TOKEN, TESTNET_RELAY_URL } from "../config.js";
import { feeTokenHint } from "./feeCurrencies.js";
import { buildPrepareParams, buildRelayClient, paymentTokenFromPrepared } from "./relay.js";
import capabilities from "./fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const CALLS = [{ to: USDC, value: 0n, data: "0x" as const }];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("buildPrepareParams", () => {
  test("names no fee token unless the caller did", () => {
    const params = buildPrepareParams({ account: "0xabc", calls: CALLS });
    expect("feeToken" in params).toBe(false);
    expect(params).toEqual({ account: "0xabc", calls: CALLS });
  });

  test("a caller's fee token is forwarded as is", () => {
    expect(buildPrepareParams({ account: "0xabc", calls: CALLS, feeToken: USDC }).feeToken).toBe(
      USDC,
    );
    expect(
      buildPrepareParams({ account: "0xabc", calls: CALLS, feeToken: NATIVE_TOKEN }).feeToken,
    ).toBe(NATIVE_TOKEN);
  });
});

describe("paymentTokenFromPrepared", () => {
  test("reads the token from the quoted intent", () => {
    expect(paymentTokenFromPrepared(prepared)).toBe(NATIVE_TOKEN);
  });

  test("a relay that charges a stablecoin reports it, checksummed", () => {
    const usdcQuote = structuredClone(prepared);
    usdcQuote.context.quote.quotes[0]!.intent.paymentToken = USDC.toLowerCase();
    expect(paymentTokenFromPrepared(usdcQuote)).toBe(getAddress(USDC));
  });

  test("no quote, no token", () => {
    expect(paymentTokenFromPrepared({ context: {} })).toBeUndefined();
    expect(paymentTokenFromPrepared(undefined)).toBeUndefined();
  });
});

describe("feeTokenHint", () => {
  test("names the tokens the relay accepts, read live", async () => {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url.replace(/\/$/, "")).toBe(TESTNET_RELAY_URL);
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("wallet_getCapabilities");
      const chain = structuredClone(capabilities["0xaa044c"]);
      chain.fees.tokens.push({
        uid: "usdc", address: USDC, decimals: 6, feeToken: true, interop: false, symbol: "USDC", nativeRate: "0x94079cd1a42aaaa",
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { "0xaa044c": chain } }));
    }) as any;

    const hint = await feeTokenHint(buildRelayClient(CELO_SEPOLIA), CELO_SEPOLIA);
    expect(hint).toContain(
      `fee tokens the relay accepts on ${CELO_SEPOLIA.chain.name}: ` +
        `${CELO_SEPOLIA.chain.nativeCurrency.symbol}, USDC`,
    );
    expect(hint).toContain("Omit `feeToken`");
  });

  test("falls back to a generic sentence when the relay cannot be asked", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as any;
    const hint = await feeTokenHint(buildRelayClient(CELO_SEPOLIA), CELO_SEPOLIA);
    expect(hint).toContain("omit `feeToken`");
    expect(hint).not.toContain(`${CELO_SEPOLIA.chain.name}:`);
  });
});

describe("buildPrepareParams: requiredFunds", () => {
  const CALLS2 = [{ to: "0x1111111111111111111111111111111111111111" as Address, value: 0n, data: "0x" as const }];
  test("forwards the funds the relay must front, and omits the key when there are none", () => {
    const funds = [{ address: NATIVE_TOKEN, value: 5n }];
    expect(buildPrepareParams({ account: "0xabc", calls: CALLS2, feeToken: NATIVE_TOKEN, requiredFunds: funds })).toEqual({
      account: "0xabc",
      calls: CALLS2,
      feeToken: NATIVE_TOKEN,
      requiredFunds: funds,
    });
    expect(buildPrepareParams({ account: "0xabc", calls: CALLS2, requiredFunds: [] })).toEqual({ account: "0xabc", calls: CALLS2 });
  });
});
