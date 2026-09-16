import { describe, expect, test } from "vitest";
import { formatAmount, parseAmount, rateStrings, shortAddress } from "../../src/lib/format";

describe("format", () => {
  test("parseAmount respects decimals", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("2", 18)).toBe(2n * 10n ** 18n);
    expect(() => parseAmount("1.1234567", 6)).toThrow(/decimals/);
    expect(() => parseAmount("abc", 6)).toThrow(/not a number/);
  });

  test("formatAmount trims zeros and caps fraction", () => {
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatAmount(10n ** 18n, 18)).toBe("1");
    expect(formatAmount(123456789n, 18, 6)).toBe("0");
    expect(formatAmount(43918200000731970n, 18)).toBe("0.043918");
  });

  test("rateStrings reads nativeRate both ways", () => {
    const r = rateStrings(666666666666666666n, "USDC", "CELO");
    expect(r.tokenInNative).toBe("1 USDC = 0.666666 CELO");
    expect(r.nativeInToken).toBe("1 CELO = 1.5 USDC");
    expect(rateStrings(0n, "X", "CELO").tokenInNative).toBe("no rate");
  });

  test("shortAddress", () => {
    expect(shortAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099…79C8");
  });
});
