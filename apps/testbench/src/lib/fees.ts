import type { FeeCurrency, HoldingsResult, NetworkConfig } from "@altananetwork/sdk";
import type { Address } from "viem";
import { sameAddress } from "./format";

/** Whether the wallet holds a positive balance of a fee currency. */
export function isHeld(currency: FeeCurrency, holdings?: HoldingsResult): boolean {
  if (!holdings) return false;
  if (currency.isNative) return holdings.native > 0n;
  return holdings.tokens.some((t) => t.ok && sameAddress(t.address, currency.address) && t.raw > 0n);
}

export function symbolFor(address: Address | undefined, currencies: readonly FeeCurrency[]): string {
  if (!address) return "unknown";
  return currencies.find((c) => sameAddress(c.address, address))?.symbol ?? address;
}

export type FeeMode = "auto" | "one" | "list";

/** Turns the Send panel's fee choice into the SDK's feeToken option. */
export function feeTokenOption(mode: FeeMode, one: Address | undefined, list: readonly Address[]): Address | Address[] | undefined {
  if (mode === "one") return one;
  if (mode === "list") return list.length ? [...list] : undefined;
  return undefined;
}

/** The native symbol as the relay names it, falling back to the chain config. */
export function nativeLabel(chainId: number, currencies: readonly FeeCurrency[] | undefined, chains: readonly NetworkConfig[]): string {
  return currencies?.find((c) => c.isNative)?.symbol ?? chains.find((c) => c.chainId === chainId)?.chain.nativeCurrency.symbol ?? "native";
}
