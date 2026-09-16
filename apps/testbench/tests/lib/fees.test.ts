import { describe, expect, test } from "vitest";
import { feeTokenOption, isHeld, symbolFor } from "../../src/lib/fees";
import { EURM, USDC, ZERO, celoFees, holdingsWithUsdc } from "../../src/test/fakeClient";

describe("fees", () => {
  test("isHeld matches token balances and native", () => {
    expect(isHeld(celoFees[2]!, holdingsWithUsdc)).toBe(true);
    expect(isHeld(celoFees[1]!, holdingsWithUsdc)).toBe(false);
    expect(isHeld(celoFees[0]!, holdingsWithUsdc)).toBe(false);
    expect(isHeld(celoFees[0]!, { native: 1n, tokens: [] })).toBe(true);
    expect(isHeld(celoFees[2]!, undefined)).toBe(false);
  });

  test("symbolFor resolves case-insensitively", () => {
    expect(symbolFor(USDC.toLowerCase() as typeof USDC, celoFees)).toBe("USDC");
    expect(symbolFor(ZERO, celoFees)).toBe("CELO");
    expect(symbolFor(undefined, celoFees)).toBe("unknown");
  });

  test("feeTokenOption maps modes to the SDK option", () => {
    expect(feeTokenOption("auto", USDC, [EURM])).toBeUndefined();
    expect(feeTokenOption("one", USDC, [EURM])).toBe(USDC);
    expect(feeTokenOption("list", USDC, [EURM, USDC])).toEqual([EURM, USDC]);
    expect(feeTokenOption("list", USDC, [])).toBeUndefined();
  });
});
