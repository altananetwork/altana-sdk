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

/**
 * Which wallets this process has seen their KeyStore registration confirm for.
 *
 * A read made right after a write can be answered by a node that has not seen
 * the write's block yet. Asked "does this wallet have keys?" such a node says
 * no, and the wallet's next action would then carry the registration a second
 * time, which the KeyStore refuses ("account already has keys"). The action
 * that follows a first action most closely is the agent identity step, sent
 * the moment the first action confirms (seen on Celo Sepolia, 2026-11-19).
 *
 * So what this process watched confirm is remembered and not asked again. A
 * registration is never undone into "no keys", so the note never goes stale.
 */
const registered = new Set<string>();

/** Record that `wallet`'s first-action registration on `chainId` confirmed. */
export function noteRegistered(chainId: number, wallet: Address): void {
  registered.add(keyOf(chainId, wallet));
}

/** True when this process saw `wallet`'s registration on `chainId` confirm. */
export function isKnownRegistered(chainId: number, wallet: Address): boolean {
  return registered.has(keyOf(chainId, wallet));
}
