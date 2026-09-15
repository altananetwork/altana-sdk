/**
 * Shapes the SDK's fee currency list for tool results: rates in whole native
 * tokens, and the wallet's balance of each token when balances are given.
 */
import type { BalancesResult, FeeCurrenciesResult } from "@altananetwork/sdk";
import { formatUnits } from "viem";

export type FeeCurrencyJson = {
  symbol: string;
  address: string;
  decimals: number;
  isNative: boolean;
  /** What one whole token is worth in the chain's native token, e.g. "12.49 CELO". */
  rate: string;
  balance?: { raw: string; display: string };
};

export type FeeCurrenciesJson = {
  chainId: number;
  /** Seconds a relay price stays valid before the token stops being quoted. */
  rateTtl: number;
  note: string;
  currencies: FeeCurrencyJson[];
};

/** The symbols the relay accepts, native first. */
export function acceptedFeeSymbols(result: FeeCurrenciesResult): string[] {
  return result.currencies.map((c) => c.symbol);
}

export function feeCurrenciesPayload(
  result: FeeCurrenciesResult,
  nativeSymbol: string,
  balances?: BalancesResult,
): FeeCurrenciesJson {
  const byAddress = new Map(
    (balances?.tokens ?? [])
      .filter((t) => t.ok)
      .map((t) => [t.address.toLowerCase(), t] as const),
  );
  const currencies = result.currencies.map((c) => {
    const line: FeeCurrencyJson = {
      symbol: c.symbol,
      address: c.address,
      decimals: c.decimals,
      isNative: c.isNative,
      rate: `${formatUnits(c.nativeRate, 18)} ${nativeSymbol}`,
    };
    if (balances) {
      if (c.isNative) {
        line.balance = { raw: balances.native.toString(), display: formatUnits(balances.native, 18) };
      } else {
        const t = byAddress.get(c.address.toLowerCase());
        if (t && t.ok) line.balance = { raw: t.raw.toString(), display: t.display };
      }
    }
    return line;
  });
  return {
    chainId: result.chainId,
    rateTtl: result.rateTtl,
    note:
      "The relay takes its fee in whichever of these tokens the wallet holds (the most " +
      "valuable one when it holds several). Omit feeToken on every call; a wallet funded " +
      "with any listed token transacts without the native token.",
    currencies,
  };
}
