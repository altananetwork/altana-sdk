/**
 * Sending a populateKey proof, and surviving the anchor moving under it.
 *
 * The cache accepts a proof only for the exact L1 block it was built against,
 * and Celo Sepolia's anchor advances about every 20 minutes. Building a proof
 * is slow (an `eth_getProof` and a header fetch), so an attempt can lose the
 * race it started, and the revert says `Cache: block header mismatch`.
 *
 * qa's dry run hit this twice in a row and succeeded on a third attempt two
 * minutes later (2026-10-05). Two fast attempts both lose the same window,
 * which is why a retry has to wait rather than fire immediately: the SDK's
 * `syncSessionToCache` pauses `anchorSettleMs`, 60 seconds by default, so that
 * every backend of a load-balanced RPC, and the relay's own node, agree on the
 * anchor before a proof is built against it.
 *
 * This is the one action the showcase turns on, and showcase key A can only be
 * proven once, so a failed attempt there has no second chance with the same
 * key. It is worth waiting rather than failing.
 */

import type { Address, Hex } from "viem";

export type ProveStatus =
  | { kind: "building"; attempt: number; anchorL1Block: bigint }
  | { kind: "sending"; attempt: number; anchorL1Block: bigint }
  | { kind: "anchor-moved"; attempt: number; from: bigint; to: bigint; waitingMs: number }
  | { kind: "done"; anchorL1Block: bigint; transactionHash?: Hex };

export type ProveResult = {
  status: string;
  transactionHash?: Hex;
  /** The L1 block the accepted proof was built against. */
  l1BlockNumber: bigint;
  /** How many attempts it took, counting the one that worked. */
  attempts: number;
};

/** The cache's own words, mapped to what they mean for the operator. */
const CACHE_REVERTS: { match: RegExp; say: string }[] = [
  {
    match: /block header mismatch/i,
    say:
      "the Celo anchor moved while the proof was being built, so the proof was for a block Celo no longer " +
      "anchors. Nothing is wrong with the key; the proof simply lost its window.",
  },
  {
    match: /call populateKey before isValidKey/i,
    say: "the cache has no entry for this key at the block Celo anchors right now, which is what proving fixes.",
  },
  {
    match: /cannot un-revoke/i,
    say:
      "the cache already holds this key as revoked, and a revocation is permanent: Ethereum can never " +
      "un-revoke, so neither can the mirror.",
  },
  { match: /user is zero/i, say: "the wallet address was empty." },
  { match: /empty public key/i, say: "the public key was empty." },
];

/** True when the revert is the anchor race, which is worth retrying. */
export function isAnchorRace(reason: string): boolean {
  return /block header mismatch/i.test(reason);
}

/**
 * Adds the cache's meaning to a revert, keeping the chain's own words.
 * Returns the reason unchanged when it is not one the cache raises.
 */
export function explainCacheRevert(reason: string): string {
  for (const { match, say } of CACHE_REVERTS) {
    if (match.test(reason)) return `${reason} In other words, ${say}`;
  }
  return reason;
}

export type ProveDeps = {
  /** The L1 block Celo anchors right now. */
  readAnchor(): Promise<bigint>;
  /** Builds the populateKey call against a named anchor. */
  buildCall(anchorL1Block: bigint): Promise<{
    to: Address;
    value: bigint;
    data: Hex;
    l1BlockNumber: bigint;
    provenKeySlot: bigint;
  }>;
  /** Sends it, from whatever wallet is paying. */
  send(call: { to: Address; value: bigint; data: Hex }): Promise<{ status: string; transactionHash?: Hex }>;
  sleep(ms: number): Promise<void>;
};

export type ProveOptions = {
  maxAttempts?: number;
  /**
   * How long to let a just-moved anchor propagate before building against it.
   * The SDK measured 60 seconds for this; a shorter wait is how two attempts
   * lose the same window.
   */
  anchorSettleMs?: number;
  onStatus?: (s: ProveStatus) => void;
};

/**
 * Proves a key into the mirror, re-encoding against the new anchor when the
 * old one moves. Pure of chain access: the caller injects it, so the retry path
 * is testable without a chain.
 */
export async function proveWithRetry(deps: ProveDeps, opts: ProveOptions = {}): Promise<ProveResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const settleMs = opts.anchorSettleMs ?? 60_000;
  const onStatus = opts.onStatus ?? (() => {});
  let lastReason = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const anchorBefore = await deps.readAnchor();
    onStatus({ kind: "building", attempt, anchorL1Block: anchorBefore });
    const call = await deps.buildCall(anchorBefore);

    if (call.provenKeySlot === 0n) {
      throw new Error(
        `The Ethereum block Celo anchors (${call.l1BlockNumber}) does not carry this key yet, so the proof ` +
          `would assert its absence and the cache would reject it. Wait for the next anchor.`,
      );
    }

    // Building is the slow part, so the anchor is checked again right before
    // sending: a proof built against a block Celo has already moved past is
    // dead on arrival, and catching it here costs nothing.
    const anchorAfter = await deps.readAnchor();
    if (anchorAfter !== call.l1BlockNumber) {
      onStatus({ kind: "anchor-moved", attempt, from: call.l1BlockNumber, to: anchorAfter, waitingMs: settleMs });
      lastReason = `the anchor moved from ${call.l1BlockNumber} to ${anchorAfter} while the proof was built`;
      if (attempt < maxAttempts) await deps.sleep(settleMs);
      continue;
    }

    onStatus({ kind: "sending", attempt, anchorL1Block: call.l1BlockNumber });
    try {
      const sent = await deps.send(call);
      if (sent.status === "CONFIRMED") {
        onStatus({
          kind: "done",
          anchorL1Block: call.l1BlockNumber,
          ...(sent.transactionHash ? { transactionHash: sent.transactionHash } : {}),
        });
        return {
          status: sent.status,
          ...(sent.transactionHash ? { transactionHash: sent.transactionHash } : {}),
          l1BlockNumber: call.l1BlockNumber,
          attempts: attempt,
        };
      }
      lastReason = `the relay returned ${sent.status}`;
      if (attempt < maxAttempts) await deps.sleep(settleMs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      lastReason = reason;
      // Only the anchor race is worth another attempt. Anything else is a real
      // answer and repeating it would just waste the operator's time.
      if (!isAnchorRace(reason)) throw new Error(explainCacheRevert(reason), { cause: err });
      onStatus({ kind: "anchor-moved", attempt, from: call.l1BlockNumber, to: call.l1BlockNumber, waitingMs: settleMs });
      if (attempt < maxAttempts) await deps.sleep(settleMs);
    }
  }

  throw new Error(
    `The proof did not land in ${maxAttempts} attempts: ${lastReason}. ` +
      `The Celo anchor advances about every 20 minutes and a proof is only valid for the block it was built ` +
      `against, so try again once it has settled.`,
  );
}
