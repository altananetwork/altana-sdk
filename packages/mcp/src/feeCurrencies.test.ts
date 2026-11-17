import { describe, expect, test } from "bun:test";
import type { BalancesResult, FeeCurrenciesResult } from "@altananetwork/sdk";
import { acceptedFeeSymbols, feeCurrenciesPayload } from "./feeCurrencies.js";

const USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const USDM = "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";

const listed: FeeCurrenciesResult = {
  chainId: 11142220,
  rateTtl: 300,
  currencies: [
    { uid: "celo", address: "0x0000000000000000000000000000000000000000", symbol: "CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true },
    { uid: "usdc", address: USDC, symbol: "USDC", decimals: 6, nativeRate: 666666666666666666n, isNative: false },
    { uid: "usdm", address: USDM, symbol: "USDm", decimals: 18, nativeRate: 12494617943320915000n, isNative: false },
  ],
};

describe("feeCurrenciesPayload", () => {
  test("rates in whole native tokens, no balances without a wallet", () => {
    const payload = feeCurrenciesPayload(listed, "CELO");
    expect(payload.chainId).toBe(11142220);
    expect(payload.rateTtl).toBe(300);
    expect(payload.currencies.map((c) => c.symbol)).toEqual(["CELO", "USDC", "USDm"]);
    expect(payload.currencies[1]).toEqual({
      symbol: "USDC",
      address: USDC,
      decimals: 6,
      isNative: false,
      rate: "0.666666666666666666 CELO",
    });
    expect(payload.note).toContain("whichever of these tokens the wallet holds");
  });

  test("with balances: native from the wallet, tokens matched by address, broken reads skipped", () => {
    const balances: BalancesResult = {
      native: 0n,
      tokens: [
        { address: USDC.toLowerCase() as `0x${string}`, ok: true, raw: 2_000_000n, decimals: 6, symbol: "USDC", display: "2" },
        { address: USDM, ok: false, error: "revert" } as never,
      ],
    };
    const payload = feeCurrenciesPayload(listed, "CELO", balances);
    expect(payload.currencies[0]!.balance).toEqual({ raw: "0", display: "0" });
    expect(payload.currencies[1]!.balance).toEqual({ raw: "2000000", display: "2" });
    expect(payload.currencies[2]!.balance).toBeUndefined();
  });
});

describe("acceptedFeeSymbols", () => {
  test("native first, as listed", () => {
    expect(acceptedFeeSymbols(listed)).toEqual(["CELO", "USDC", "USDm"]);
  });
});
