import type { FeeCurrency, HoldingsResult, NetworkConfig } from "@altananetwork/sdk";
import type { Address } from "viem";
import { sameAddress } from "./format";

/** Whether the wallet holds a positive balance of a fee currency. */
export function isHeld(currency: FeeCurrency, holdings?: { native: bigint; tokens: readonly { address: Address; ok: boolean; raw?: bigint }[] }): boolean {
  if (!holdings) return false;
  if (currency.isNative) return holdings.native > 0n;
  return holdings.tokens.some((t) => t.ok && sameAddress(t.address, currency.address) && (t.raw ?? 0n) > 0n);
}

export function symbolFor(address: Address | undefined, currencies: readonly FeeCurrency[]): string {
  if (!address) return "unknown";
  return currencies.find((c) => sameAddress(c.address, address))?.symbol ?? address;
}

/**
 * What an empty token table means now that the bench reads the chain too.
 *
 * Holdings come from the relay's ERC-7811 `wallet_getAssets`, which on Celo
 * Sepolia answers with the native balance alone: the relay's token discovery
 * runs on NodeReal, enabled for chains 1 and 56 only. So the bench also reads
 * `balanceOf` for the tokens it knows about on the chain and merges the two.
 *
 * Even then this cannot say the wallet holds no tokens, only that none of the
 * tokens either source knows about came back with a balance. A token in
 * neither list is still invisible, so the sentence says what was looked at.
 */
export const EMPTY_HOLDINGS_NOTE =
  "No balance found for any token this bench knows about on this chain. The relay lists no ERC-20s here, so these are read from the chain directly; a token in neither list would not appear.";

/** The sweep moves the same merged list, so it covers the same ground. */
export const SWEEP_SCOPE_NOTE =
  "Moved every token found, from the relay's own list and from reading this chain's known tokens directly, then the native balance. A token in neither list would not have been seen.";

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
