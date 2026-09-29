import { describe, expect, test } from "vitest";
import {
  canPopulate,
  decodePackedKey,
  minutesUntilProvable,
  mirrorState,
  mirrorSummary,
  type MirrorReading,
} from "../../src/lib/mirror";
import { mirrorCurrent, packKey } from "../../src/test/fakeClient";

function reading(patch: Partial<MirrorReading>): MirrorReading {
  return { ...mirrorCurrent, ...patch };
}

describe("decodePackedKey", () => {
  test("reads the fields at the offsets the cache reads them at", () => {
    expect(decodePackedKey(0n)).toEqual({ present: false, revoked: false, expiry: 0, isRoot: false });
    expect(decodePackedKey(packKey())).toEqual({ present: true, revoked: false, expiry: 0, isRoot: false });
    expect(decodePackedKey(packKey({ revoked: true }))).toMatchObject({ present: true, revoked: true });
    expect(decodePackedKey(packKey({ expiry: 1_790_000_123 }))).toMatchObject({ expiry: 1_790_000_123 });
    expect(decodePackedKey(packKey({ isRoot: true }))).toMatchObject({ isRoot: true });
  });

  test("a revoked key with a timebox decodes both, and neither bleeds into the other", () => {
    const packed = packKey({ revoked: true, expiry: 1_790_000_123, isRoot: true });
    expect(decodePackedKey(packed)).toEqual({
      present: true,
      revoked: true,
      expiry: 1_790_000_123,
      isRoot: true,
    });
  });
});

describe("mirrorState", () => {
  test("no KeyStore entry at all: there is nothing to mirror", () => {
    const state = mirrorState(reading({ livePacked: 0n, anchorPacked: 0n, cachedPresent: false }));
    expect(state).toEqual({ kind: "never-registered" });
    expect(canPopulate(state)).toBe(false);
  });

  test("(a) registered, but the anchor still predates the write", () => {
    const state = mirrorState(
      reading({
        livePacked: packKey(),
        anchorPacked: 0n,
        cachedPresent: false,
        cachedSourceBlock: 0n,
        anchorL1Block: 11807636n,
        l1Head: 11807700n,
      }),
    );
    expect(state).toEqual({ kind: "not-yet-provable", carries: "absence", blocksBehind: 64n });
    expect(canPopulate(state)).toBe(false);
    // The operator must read this as a wait, not a failure.
    expect(mirrorSummary(state)).toContain("normal half-hour wait");
  });

  test("(a) revoked on Ethereum, but the anchor still carries the key as live", () => {
    const state = mirrorState(
      reading({
        livePacked: packKey({ revoked: true }),
        anchorPacked: packKey(),
        cachedPresent: true,
        cachedSourceBlock: 11807600n,
      }),
    );
    expect(state).toMatchObject({ kind: "not-yet-provable", carries: "pre-revocation" });
    // Proving now would re-assert it live, so the button must be off.
    expect(canPopulate(state)).toBe(false);
  });

  test("(b) the anchor carries the registration and the cache has never seen it", () => {
    const state = mirrorState(
      reading({ livePacked: packKey(), anchorPacked: packKey(), cachedPresent: false, cachedSourceBlock: 0n }),
    );
    expect(state).toEqual({ kind: "provable", wouldBeRevoked: false, everProven: false });
    expect(canPopulate(state)).toBe(true);
  });

  test("(b) the anchor carries a revocation the cache has never seen", () => {
    const state = mirrorState(
      reading({
        livePacked: packKey({ revoked: true }),
        anchorPacked: packKey({ revoked: true }),
        cachedPresent: false,
        cachedSourceBlock: 0n,
      }),
    );
    expect(state).toMatchObject({ kind: "provable", wouldBeRevoked: true });
    expect(mirrorSummary(state)).toContain("carries the revocation");
  });

  test("(c) proven against the block Celo anchors right now", () => {
    const state = mirrorState(mirrorCurrent);
    expect(state).toEqual({ kind: "current" });
    expect(canPopulate(state)).toBe(false);
  });

  test("(c) proven against the current anchor, and the proof says revoked", () => {
    const state = mirrorState(
      reading({
        livePacked: packKey({ revoked: true }),
        anchorPacked: packKey({ revoked: true }),
        cachedRevoked: true,
      }),
    );
    expect(state).toEqual({ kind: "revoked" });
  });

  test("(c) proven against the current anchor, with the timebox already passed", () => {
    const state = mirrorState(reading({ cachedExpiry: 1_789_999_000, readAt: 1_790_000_000 }));
    expect(state).toEqual({ kind: "expired", expiry: 1_789_999_000 });
  });

  test("a timebox still running is not expired", () => {
    expect(mirrorState(reading({ cachedExpiry: 1_790_000_600, readAt: 1_790_000_000 }))).toEqual({
      kind: "current",
    });
  });

  test("(d) proven against an older anchor: the cache answers not valid until it is proven again", () => {
    const state = mirrorState(reading({ cachedSourceBlock: 11807607n, anchorL1Block: 11807636n }));
    expect(state).toEqual({ kind: "stale", provenAt: 11807607n, wouldBeRevoked: false });
    expect(canPopulate(state)).toBe(true);
    expect(mirrorSummary(state)).toContain("requires the two to be equal");
  });

  test("the revoked state is read from the proof, not from the live KeyStore", () => {
    // Revoked on Ethereum, proven at the current anchor from before the
    // revocation: the mirror still says live, and truthfully so.
    const state = mirrorState(
      reading({ livePacked: packKey({ revoked: true }), anchorPacked: packKey(), cachedRevoked: false }),
    );
    expect(state).toEqual({ kind: "current" });
  });
});

describe("minutesUntilProvable", () => {
  test("rounds up to whole anchor jumps and is zero when already caught up", () => {
    expect(minutesUntilProvable(0n)).toBe(0);
    expect(minutesUntilProvable(-5n)).toBe(0);
    expect(minutesUntilProvable(1n)).toBe(20);
    expect(minutesUntilProvable(29n)).toBe(20);
    expect(minutesUntilProvable(30n)).toBe(40);
    expect(minutesUntilProvable(90n)).toBe(80);
  });
});

describe("mirrorSummary", () => {
  test("every state has a sentence, and none of them is a bare no", () => {
    const states = [
      { kind: "never-registered" },
      { kind: "not-yet-provable", carries: "absence", blocksBehind: 10n },
      { kind: "not-yet-provable", carries: "pre-revocation", blocksBehind: 10n },
      { kind: "provable", wouldBeRevoked: false, everProven: false },
      { kind: "current" },
      { kind: "revoked" },
      { kind: "expired", expiry: 1 },
      { kind: "stale", provenAt: 1n, wouldBeRevoked: false },
    ] as const;
    for (const s of states) {
      const text = mirrorSummary(s);
      expect(text.length).toBeGreaterThan(40);
      expect(text).not.toMatch(/^(no|not valid)\b/i);
    }
  });
});
