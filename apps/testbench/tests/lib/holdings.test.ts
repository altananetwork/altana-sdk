import { describe, expect, test } from "vitest";
import { describeSources, knownTokensFor, mergeHoldings, readOnChainBalances } from "../../src/lib/holdings";
import { USDC, EURM, ZERO } from "../../src/test/fakeClient";

/**
 * The relay enumerates ERC-20s through NodeReal, enabled for chains 1 and 56
 * only, so on Celo Sepolia `wallet_getAssets` answers with the native balance
 * alone and a wallet holding 0.09 USDC reads as holding nothing (qa,
 * 2026-10-05). It can still TRANSFER what it cannot LIST, so the gap is in
 * enumeration and the fix is to ask the chain for the rest.
 */
describe("holdings the relay cannot enumerate", () => {
  const nativeOnly = { native: 10n ** 18n, tokens: [] };

  test("a token only the chain knows about is added, and says so", () => {
    const merged = mergeHoldings(nativeOnly, [
      { address: USDC, ok: true, raw: 90_000n, decimals: 6, symbol: "USDC", display: "0.09" },
    ]);
    expect(merged.tokens).toEqual([
      { address: USDC, ok: true, raw: 90_000n, decimals: 6, symbol: "USDC", display: "0.09", via: "chain" },
    ]);
    expect(describeSources(merged)).toEqual({ relay: 0, chain: 1 });
    expect(merged.native).toBe(10n ** 18n);
  });

  test("the relay's own answer is kept, never replaced by the chain read", () => {
    const relay = {
      native: 0n,
      tokens: [{ address: USDC, ok: true as const, raw: 2_000_000n, decimals: 6, symbol: "USDC", display: "2" }],
    };
    // A chain read of the same token, with a different balance, must not win:
    // substituting silently would hide a relay that is answering wrongly
    // rather than not at all.
    const merged = mergeHoldings(relay, [
      { address: USDC, ok: true, raw: 999n, decimals: 6, symbol: "USDC", display: "0.000999" },
    ]);
    expect(merged.tokens).toHaveLength(1);
    expect(merged.tokens[0]).toMatchObject({ raw: 2_000_000n, via: "relay" });
  });

  test("a zero chain balance is dropped, a failed read is kept", () => {
    const merged = mergeHoldings(nativeOnly, [
      { address: USDC, ok: true, raw: 0n, decimals: 6, symbol: "USDC", display: "0" },
      { address: EURM, ok: false, error: "reverted" },
    ]);
    // Zero is known-absent and clutters the table; a failed read is NOT known
    // to be absent, and the sweep must not treat the two alike.
    expect(merged.tokens.map((t) => t.address)).toEqual([EURM]);
  });

  test("the token list to ask about covers the chain registry even with no fee tokens", () => {
    const known = knownTokensFor(11142220, [
      { uid: "native", address: ZERO, symbol: "S-CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true },
    ]);
    const usdc = known.find((t) => t.address === USDC);
    expect(usdc).toMatchObject({ symbol: "USDC", decimals: 6 });
  });

  test("a reverting balanceOf is kept as a failed row, with the reason decoded", async () => {
    const client = {
      readContract: async () => {
        throw new Error("execution reverted: Error(string)");
      },
    };
    const [row] = await readOnChainBalances(client as never, ZERO, [{ address: USDC, symbol: "USDC", decimals: 6 }]);
    expect(row).toMatchObject({ address: USDC, ok: false });
  });

  test("a successful read carries the token's own decimals into the display", async () => {
    const client = { readContract: async () => 2_500_000n };
    const [row] = await readOnChainBalances(client as never, ZERO, [{ address: USDC, symbol: "USDC", decimals: 6 }]);
    // 2.5, not 0.0000000000025: the decimals come from the token.
    expect(row).toMatchObject({ ok: true, raw: 2_500_000n, display: "2.5" });
  });
});
