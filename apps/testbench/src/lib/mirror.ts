/**
 * The Celo mirror: reading a key's state out of the Celo KeyStoreCache, and
 * deciding what the operator can do about it right now.
 *
 * The deployed cache is `KeyStoreCacheOPStack` 1.1.1 at
 * 0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD on Celo Sepolia, and its
 * `isValidKey` requires **equality**, not recency:
 *
 *     require(k.sourceBlockNumber == IL1Block(L1_BLOCK_PREDEPLOY).number())
 *
 * Celo Sepolia's anchor advances in jumps of about 28 to 30 L1 blocks roughly
 * every 20 minutes, trailing the Sepolia head by 15 to 20 minutes
 * (evidence/2026-09-29-celo-sepolia-anchor-lag.md). Two consequences shape
 * this whole module:
 *
 * 1. A KeyStore write is provable about half an hour after it lands, not at
 *    once. Before that a proof built against the anchored block proves the
 *    key's *absence*, and the cache rejects it.
 * 2. A proof is good for one anchor, about 20 minutes. After the next anchor
 *    update the same key reads as not valid with nothing having changed on
 *    Ethereum, until someone proves it again.
 *
 * So a cached key is an assertion about one anchored L1 block, not a durable
 * mirror, and the card says which of the five situations the key is in rather
 * than a bare yes or no. Reporting "not valid" alone would be true and
 * useless.
 *
 * Both the live KeyStore state and the state the anchor carries are read as
 * the same packed storage slot, so they are directly comparable: that is what
 * separates "the registration has not reached the anchor yet" from "the
 * revocation has not reached the anchor yet" from "a proof would work now".
 */

import type { Address, Hex } from "viem";

/** L1 KeyStore v1.0.0 packed Key slot, as KeyStoreCacheOPStack._decodePackedKey reads it. */
export type PackedKey = {
  /** Zero packed value: the key has no entry at that block. */
  present: boolean;
  revoked: boolean;
  /** Unix seconds; 0 means no expiry. */
  expiry: number;
  isRoot: boolean;
};

export function decodePackedKey(packed: bigint): PackedKey {
  return {
    present: packed !== 0n,
    revoked: ((packed >> 128n) & 0xffn) !== 0n,
    expiry: Number((packed >> 136n) & 0xffffffffffn),
    isRoot: ((packed >> 176n) & 0xffn) !== 0n,
  };
}

/** What a single read of the mirror and its two KeyStore slots found. */
export type MirrorReading = {
  /** The L1 block Celo currently anchors. */
  anchorL1Block: bigint;
  /** The registry chain's own head, for the gap the card shows. */
  l1Head: bigint;
  /** The key's packed KeyStore slot at the registry head: the truth. */
  livePacked: bigint;
  /** The same slot at the anchored block: what a proof built now would carry. */
  anchorPacked: bigint;
  /** Block the cache entry was proven against; 0 when never proven. */
  cachedSourceBlock: bigint;
  /** Cache entry fields, as populateKey last wrote them. */
  cachedRevoked: boolean;
  cachedExpiry: number;
  /** True when the cache holds an entry for the key at all. */
  cachedPresent: boolean;
  /** The cache's own isValidKey, with its staleness revert mapped to false. */
  cacheSaysValid: boolean;
  /** Seconds since the epoch when the reading was taken, for the expiry check. */
  readAt: number;
};

export type MirrorState =
  /** The key has no KeyStore entry on Ethereum at all. Nothing to mirror. */
  | { kind: "never-registered" }
  /**
   * (a) The anchor does not carry the state yet. `carries` says whether it
   * still shows the key absent (a fresh registration) or still shows it live
   * (a revocation that has not reached the anchor).
   */
  | { kind: "not-yet-provable"; carries: "absence" | "pre-revocation"; blocksBehind: bigint }
  /** (b) A proof built now carries the current KeyStore state. Send it. */
  | { kind: "provable"; wouldBeRevoked: boolean; everProven: boolean }
  /** (c) Proven against the block Celo anchors right now, and live. */
  | { kind: "current" }
  /** (c) Proven against the current anchor, and the proof says revoked. */
  | { kind: "revoked" }
  /** (c) Proven against the current anchor, but the timebox has passed. */
  | { kind: "expired"; expiry: number }
  /** (d) Proven, but against an older anchor. Prove it again. */
  | { kind: "stale"; provenAt: bigint; wouldBeRevoked: boolean };

/**
 * Which of the five situations the key is in. Pure: every input comes from
 * one `MirrorReading`, so the card's states are testable without a chain.
 */
export function mirrorState(r: MirrorReading): MirrorState {
  const live = decodePackedKey(r.livePacked);
  const atAnchor = decodePackedKey(r.anchorPacked);

  if (!live.present) return { kind: "never-registered" };

  // Proven against the block Celo anchors right now: the cache answers for it.
  if (r.cachedPresent && r.cachedSourceBlock === r.anchorL1Block) {
    if (r.cachedRevoked) return { kind: "revoked" };
    if (r.cachedExpiry !== 0 && r.readAt > r.cachedExpiry) return { kind: "expired", expiry: r.cachedExpiry };
    return { kind: "current" };
  }

  // Not proven at this anchor. Can a proof built now carry the truth?
  const blocksBehind = r.l1Head > r.anchorL1Block ? r.l1Head - r.anchorL1Block : 0n;
  if (!atAnchor.present) return { kind: "not-yet-provable", carries: "absence", blocksBehind };
  if (live.revoked && !atAnchor.revoked) {
    return { kind: "not-yet-provable", carries: "pre-revocation", blocksBehind };
  }

  if (r.cachedPresent) {
    return { kind: "stale", provenAt: r.cachedSourceBlock, wouldBeRevoked: atAnchor.revoked };
  }
  return { kind: "provable", wouldBeRevoked: atAnchor.revoked, everProven: false };
}

/** True when the state's action is to send a populateKey proof. */
export function canPopulate(state: MirrorState): boolean {
  return state.kind === "provable" || state.kind === "stale";
}

/**
 * One sentence for the card, in the operator's terms. Each says what is true
 * and what happens next, because every one of these except "current" looks
 * like a failure and is not.
 */
export function mirrorSummary(state: MirrorState): string {
  switch (state.kind) {
    case "never-registered":
      return "This key has no entry in the Ethereum Sepolia KeyStore, so there is nothing to prove into Celo yet.";
    case "not-yet-provable":
      return state.carries === "absence"
        ? "Registered on Ethereum, but Celo still anchors an older Ethereum block in which the key does not exist. A proof built now would prove its absence and the cache would reject it. This is the normal half-hour wait, not a failure."
        : "Revoked on Ethereum, but Celo still anchors an Ethereum block from before the revocation. Proving now would re-assert the key as live, so the card waits for the next anchor.";
    case "provable":
      return state.wouldBeRevoked
        ? "Celo now anchors an Ethereum block that carries the revocation. Send the proof."
        : "Celo now anchors an Ethereum block that carries this key. Send the proof; the anchor moves about every 20 minutes, so do it now rather than later.";
    case "current":
      return "Proven against the Ethereum block Celo anchors right now. Any contract on Celo reads this key as valid, from Celo state alone.";
    case "revoked":
      return "Proven against the block Celo anchors right now, and the proof carries the revocation. The mirror reads this key as revoked.";
    case "expired":
      return "Proven against the current anchor, and the timebox has passed. The mirror reads this key as no longer valid.";
    case "stale":
      return "Proven, but against an older Ethereum block than the one Celo anchors now. The cache requires the two to be equal, so it answers not valid until the key is proven again.";
  }
}

/** The anchor advances in jumps of about 28 to 30 blocks, roughly every 20 minutes. */
export const ANCHOR_PERIOD_MINUTES = 20;
export const ANCHOR_JUMP_BLOCKS = 29n;

/**
 * A rough wait, in minutes, before the anchor reaches the registry head. Shown
 * as progress, never as a countdown to a promise: the cadence is observed, not
 * guaranteed, so the card rounds up and says "about".
 */
export function minutesUntilProvable(blocksBehind: bigint): number {
  if (blocksBehind <= 0n) return 0;
  const jumps = (blocksBehind + ANCHOR_JUMP_BLOCKS - 1n) / ANCHOR_JUMP_BLOCKS;
  return Number(jumps) * ANCHOR_PERIOD_MINUTES;
}

/** Identifies the key a mirror card is about. */
export type MirrorTarget = {
  /** The wallet whose KeyStore entry is mirrored. */
  user: Address;
  /** keccak256 of the public key. Enough to read the mirror. */
  keyId: Hex;
  /**
   * The full SEC1 public key bytes. Needed to *send* a proof, because
   * populateKey takes the key itself and the cache checks that it hashes to
   * the keyId. Absent when the operator typed a bare keyId, and then the card
   * reads but cannot prove.
   */
  publicKey?: Hex;
  /** Where the target came from, for the card's label. */
  label?: string;
};
