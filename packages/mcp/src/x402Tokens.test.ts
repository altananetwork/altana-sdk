import { describe, expect, test } from "bun:test";
import { x402SpendCapsFrom, x402TokensFrom } from "./x402Tokens.js";

const USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
const USAT = "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771";

describe("grant_session x402Tokens", () => {
  test("nothing given, or an empty list: the session is not set up for x402", () => {
    expect(x402TokensFrom(undefined)).toBeUndefined();
    expect(x402TokensFrom([])).toBeUndefined();
  });

  test("one address or a list both become a list", () => {
    expect(x402TokensFrom(USDC)).toEqual([USDC]);
    expect(x402TokensFrom([USDC, USAT])).toEqual([USDC, USAT]);
  });

  test("the same token twice is approved once, whatever its letter case", () => {
    expect(x402TokensFrom([USDC, USDC.toLowerCase(), USAT])).toEqual([USDC, USAT]);
  });

  test("something that is not an address is refused before any grant is sent", () => {
    expect(() => x402TokensFrom("USDC")).toThrow(/Not a valid 0x-prefixed 20-byte address: USDC/);
    expect(() => x402TokensFrom([USDC, "0x1234"])).toThrow(/Not a valid/);
  });

  test("the native coin is refused: x402 pays in a token", () => {
    expect(() => x402TokensFrom("0x0000000000000000000000000000000000000000")).toThrow(/not in the chain's native coin/);
  });
});

describe("grant_session x402SpendLimit", () => {
  test("left out, no cap is added: the session pays x402 as it did before the input existed", () => {
    expect(x402SpendCapsFrom([USDC as `0x${string}`], undefined)).toEqual([]);
    expect(x402SpendCapsFrom(undefined, undefined)).toEqual([]);
  });

  test("each x402 token gets the same daily cap, in its smallest unit", () => {
    expect(x402SpendCapsFrom([USDC as `0x${string}`, USAT as `0x${string}`], "5000000")).toEqual([
      { token: USDC, limit: 5_000_000n, period: "day" },
      { token: USAT, limit: 5_000_000n, period: "day" },
    ]);
  });

  test("a limit with no token to cap is refused, as is zero or anything that is not a whole number", () => {
    expect(() => x402SpendCapsFrom(undefined, "5000000")).toThrow("needs x402Tokens");
    expect(() => x402SpendCapsFrom([USDC as `0x${string}`], "0")).toThrow("above zero");
    expect(() => x402SpendCapsFrom([USDC as `0x${string}`], "5.5")).toThrow("whole number");
  });
});
