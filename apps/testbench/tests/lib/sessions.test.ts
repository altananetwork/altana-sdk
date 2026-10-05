import { describe, expect, test } from "vitest";
import { buildGrant, capTokenOptions, defaultForm, describeCaps, describeStatus, withX402Cap } from "../../src/lib/sessions";
import type { FeeCurrency } from "@altananetwork/sdk";
import { EURM, USDC, ZERO, celoFees } from "../../src/test/fakeClient";

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

/**
 * The relay's fee currencies are what it takes for GAS. A spend cap bounds what
 * the session SPENDS. Sourcing the second list from the first made a USDC cap
 * unsettable on the live relay, which offers only native S-CELO, so a session
 * approved to pay x402 in USDC was capped only in a token it never spends
 * (qa, 2026-10-05). These tests use a relay that lists no ERC-20 fee token at
 * all, because that is the shape the live relay has and the shape a fixture
 * copied from the fee list can never reproduce.
 */
describe("cap tokens are the chain's tokens, not the relay's fee list", () => {
  const nativeOnlyRelay: FeeCurrency[] = [
    { uid: "s-celo", address: ZERO, symbol: "S-CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true },
  ];

  test("a USDC cap can be set against a relay offering no ERC-20 fee token", () => {
    const capTokens = capTokenOptions(11142220, nativeOnlyRelay);
    expect(capTokens.some((t) => t.address === USDC)).toBe(true);

    const form = { ...defaultForm(11142220), caps: [{ amount: "2.5", period: "day" as const, token: USDC }] };
    expect(buildGrant(form, capTokens).permissions.spend).toEqual([{ limit: 2_500_000n, period: "day", token: USDC }]);
  });

  test("a cap in an unknown token is refused rather than scaled by a guessed 18", () => {
    const capTokens = capTokenOptions(11142220, nativeOnlyRelay);
    const unknown = "0x000000000000000000000000000000000000dEaD" as const;
    const form = { ...defaultForm(11142220), caps: [{ amount: "10", period: "day" as const, token: unknown }] };
    // Defaulting to 18 here would write a cap 10^12 times the one asked for on
    // a 6-decimal token, which is not a mislabelled cap but the absence of one.
    expect(() => buildGrant(form, capTokens)).toThrow(/decimals are not known/);
  });

  test("the relay's own fee tokens stay settable, with the decimals it reported", () => {
    const capTokens = capTokenOptions(11142220, celoFees);
    const eurm = capTokens.find((t) => t.address === EURM);
    expect(eurm).toEqual({ symbol: "EURm", address: EURM, decimals: 18 });
    // Listed once, though it is in both the fee list and the chain registry.
    expect(capTokens.filter((t) => t.address === USDC)).toHaveLength(1);
  });

  test("describeCaps reads a USDC cap back in USDC on a native-only relay", () => {
    const capTokens = capTokenOptions(11142220, nativeOnlyRelay);
    expect(describeCaps([{ limit: "2500000", period: "day", token: USDC }], capTokens, "S-CELO")).toBe("2.5 USDC per day");
    // The old fee-list source had no entry for USDC, so it fell back to 18
    // decimals and rendered this same cap as a rounding error.
    expect(describeCaps([{ limit: "2500000", period: "day", token: USDC }], nativeOnlyRelay as never, "S-CELO")).not.toContain("2.5 USDC");
  });

  test("ticking a token to pay x402 with points the first cap at it", () => {
    const base = defaultForm(11142220);
    expect(base.caps[0]!.token).toBe("native");
    expect(withX402Cap(base, USDC).caps[0]!.token).toBe(USDC);
  });

  test("a cap someone already set in a token is left alone", () => {
    const chosen = { ...defaultForm(11142220), caps: [{ amount: "1", period: "day" as const, token: EURM }] };
    expect(withX402Cap(chosen, USDC).caps[0]!.token).toBe(EURM);
  });
});

describe("describeStatus", () => {
  test("explains the cache sync wait with the chain and elapsed time", () => {
    const text = describeStatus("cache-sync", "Celo Sepolia Testnet", 95);
    expect(text).toContain("Celo Sepolia Testnet (1 min 35 s)");
    expect(text).toContain("15 to 20 minutes behind Sepolia");
  });
  test("names the other steps", () => {
    expect(describeStatus("registry-write", undefined, 0)).toBe("Writing the key to the Keystore on Sepolia");
    expect(describeStatus("done", undefined, 3)).toBe("Done");
  });
});
