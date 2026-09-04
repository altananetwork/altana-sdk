/**
 * wallet_balance's JSON must carry every SDK field with bigints as decimal
 * strings, omit `tokens` for native-only reads, and flag discovered lists.
 */
import { describe, expect, test } from "bun:test";
import type { TokenBalance } from "@altananetwork/sdk";
import { formatBalance, formatTokenBalance } from "./balanceFormat.js";

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x55d398326f99059fF775485246999027B3197955" as const;

describe("formatTokenBalance", () => {
  test("plain token: bigints become strings, no scaled key", () => {
    const t: TokenBalance = {
      address: TOKEN,
      ok: true,
      raw: 12_500_000n,
      decimals: 6,
      symbol: "USDT",
      display: "12.5",
    };
    expect(formatTokenBalance(t)).toEqual({
      address: TOKEN,
      symbol: "USDT",
      decimals: 6,
      raw: "12500000",
      display: "12.5",
    });
  });

  test("BEP-677 token: scaled and pending are stringified", () => {
    const t: TokenBalance = {
      address: TOKEN,
      ok: true,
      raw: 1000n,
      decimals: 0,
      symbol: "sTOK",
      display: "1500",
      scaled: {
        uiMultiplier: 15n * 10n ** 17n,
        scaledRaw: 1500n,
        pending: { newUIMultiplier: 2n * 10n ** 18n, effectiveAt: 1_900_000_000n },
      },
    };
    expect(formatTokenBalance(t)).toEqual({
      address: TOKEN,
      symbol: "sTOK",
      decimals: 0,
      raw: "1000",
      display: "1500",
      scaled: {
        uiMultiplier: "1500000000000000000",
        scaledRaw: "1500",
        pending: { newUIMultiplier: "2000000000000000000", effectiveAt: "1900000000" },
      },
    });
  });

  test("scaled without pending omits the pending key", () => {
    const t: TokenBalance = {
      address: TOKEN,
      ok: true,
      raw: 1n,
      decimals: 0,
      symbol: "s",
      display: "1",
      scaled: { uiMultiplier: 10n ** 18n, scaledRaw: 1n },
    };
    const out = formatTokenBalance(t);
    if (!("scaled" in out) || !out.scaled) throw new Error("expected scaled");
    expect("pending" in out.scaled).toBe(false);
  });

  test("failed read: address + error only", () => {
    const t: TokenBalance = { address: TOKEN, ok: false, error: "balanceOf() read failed" };
    expect(formatTokenBalance(t)).toEqual({ address: TOKEN, error: "balanceOf() read failed" });
  });
});

describe("formatBalance", () => {
  test("native only: no tokens key, no discovered key", () => {
    const out = formatBalance({ name: "main", address: ADDR, native: 10n ** 18n });
    expect(out).toEqual({
      name: "main",
      address: ADDR,
      balanceWei: "1000000000000000000",
      balanceEth: "1",
    });
  });

  test("explicit tokens: tokens present, discovered absent", () => {
    const out = formatBalance({
      name: "main",
      address: ADDR,
      native: 0n,
      tokens: [{ address: TOKEN, ok: false, error: "decimals() read failed" }],
    });
    expect(out.tokens).toEqual([{ address: TOKEN, error: "decimals() read failed" }]);
    expect("discovered" in out).toBe(false);
  });

  test("discovered tokens: discovered: true, empty list survives", () => {
    const out = formatBalance({ name: "main", address: ADDR, native: 0n, tokens: [], discovered: true });
    expect(out.tokens).toEqual([]);
    expect(out.discovered).toBe(true);
  });

  test("the payload is JSON-serialisable (no bigints left)", () => {
    const out = formatBalance({
      name: "main",
      address: ADDR,
      native: 5n,
      tokens: [
        {
          address: TOKEN,
          ok: true,
          raw: 1n,
          decimals: 18,
          symbol: "T",
          display: "0.000000000000000001",
          scaled: { uiMultiplier: 10n ** 18n, scaledRaw: 1n },
        },
      ],
      discovered: true,
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
