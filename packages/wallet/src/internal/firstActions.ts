import type { Address } from "viem";

/**
 * Which wallets this process has just sent their FIRST admin action for.
 *
 * `submitCallsDetailed` notes a wallet here when the intent it sent carried
 * the first-action KeyStore registration. The agent identity step reads the
 * note once that action has confirmed, and only then sends its own
 * transaction. That is the whole coupling between the two: a note. Nothing in
 * the first action's calls, signing or sending depends on it.
 *
 * A note is kept until a confirmed admin action takes it, so a first action
 * sent with `noWait`, or through a call that does not run the step, is picked
 * up by the wallet's next confirmed `execute` or `grantSession`.
 */
const noted = new Set<string>();

const keyOf = (chainId: number, wallet: Address): string => `${chainId}:${wallet.toLowerCase()}`;

/** Record that `wallet`'s first admin action on `chainId` was just sent. */
export function noteFirstAction(chainId: number, wallet: Address): void {
  noted.add(keyOf(chainId, wallet));
}

/** True when a first action was noted for `wallet` on `chainId`. Does not clear it. */
export function hasFirstAction(chainId: number, wallet: Address): boolean {
  return noted.has(keyOf(chainId, wallet));
}

/** Clear the note. Returns whether there was one. */
export function clearFirstAction(chainId: number, wallet: Address): boolean {
  return noted.delete(keyOf(chainId, wallet));
}
