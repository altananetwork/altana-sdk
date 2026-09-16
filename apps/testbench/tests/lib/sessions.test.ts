import { describe, expect, test } from "vitest";
import { buildGrant, defaultForm, describeCaps } from "../../src/lib/sessions";
import { EURM, USDC, celoFees } from "../../src/test/fakeClient";

describe("session form", () => {
  test("buildGrant parses caps with token decimals and computes expiry", () => {
    const form = { ...defaultForm(11142220), caps: [{ amount: "2.5", period: "day" as const, token: USDC }, { amount: "0.1", period: "week" as const, token: "native" as const }], days: "2", scopeTo: "" };
    const before = Math.floor(Date.now() / 1000);
    const { permissions, expiry } = buildGrant(form, celoFees);
    expect(permissions.spend).toEqual([
      { limit: 2_500_000n, period: "day", token: USDC },
      { limit: 10n ** 17n, period: "week" },
    ]);
    expect(permissions.calls).toBeUndefined();
    expect(expiry).toBeGreaterThanOrEqual(before + 2 * 86400 - 1);
    expect(expiry).toBeLessThanOrEqual(before + 2 * 86400 + 5);
  });

  test("buildGrant adds a call scope and validates input", () => {
    const base = defaultForm(11142220);
    expect(buildGrant({ ...base, scopeTo: EURM }, celoFees).permissions.calls).toEqual([{ to: EURM }]);
    expect(() => buildGrant({ ...base, scopeTo: "0x12" }, celoFees)).toThrow(/contract address/);
    expect(() => buildGrant({ ...base, days: "0" }, celoFees)).toThrow(/positive/);
    expect(() => buildGrant({ ...base, caps: [] }, celoFees)).toThrow(/spend cap/);
    expect(() => buildGrant({ ...base, chainIds: [] }, celoFees)).toThrow(/chain/);
    expect(() => buildGrant({ ...base, caps: [{ amount: "1.1234567", period: "day", token: USDC }] }, celoFees)).toThrow(/decimals/);
  });

  test("describeCaps renders human text from serialized caps", () => {
    expect(describeCaps([{ limit: "2500000", period: "day", token: USDC }, { limit: "100000000000000000", period: "week" }], celoFees, "CELO")).toBe(
      "2.5 USDC per day, 0.1 CELO per week",
    );
  });
});
