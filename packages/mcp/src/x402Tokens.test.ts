import { describe, expect, test } from "bun:test";
import { x402TokensFrom } from "./x402Tokens.js";

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
