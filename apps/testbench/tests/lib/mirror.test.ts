import { describe, expect, test } from "vitest";
import { keccak256 } from "viem";
import {
  canPopulate,
  decodePackedKey,
  minutesUntilProvable,
  mirrorState,
  mirrorSummary,
  targetFromInput,
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

describe("targetFromInput", () => {
  const WALLET = "0x6A75e80B961f7d884f9D03E5Aa0808d05e47c50d" as const;
  const KEY_ID = "0x26aaf13c72b195571d3d7587c9df471e3f0752fb297da285e961267ac898e87d" as const;
  const PUBLIC_KEY =
    "0x04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9" as const;

  test("a key id gives a target that can be read and not proven", () => {
    const { target } = targetFromInput({ wallet: WALLET, key: KEY_ID });
    expect(target).toMatchObject({ user: WALLET, keyId: KEY_ID });
    expect(target?.publicKey).toBeUndefined();
  });

  test("a public key is hashed, and carried so the key can be proven", () => {
    const { target } = targetFromInput({ wallet: WALLET, key: PUBLIC_KEY });
    expect(target?.publicKey).toBe(PUBLIC_KEY);
    expect(target?.keyId).toBe(keccak256(PUBLIC_KEY));
  });

  test("a blank wallet falls back to the one in the browser", () => {
    expect(targetFromInput({ wallet: "  ", key: KEY_ID, fallbackWallet: WALLET }).target?.user).toBe(WALLET);
  });

  test("a value the message calls invalid never becomes a target", () => {
    // The form's message and the chain read must not disagree: 0xdeadbeef is
    // hex, and is neither a key id nor a public key.
    for (const key of ["not hex", "0xdeadbeef", "0x"]) {
      const out = targetFromInput({ wallet: WALLET, key });
      expect(out.target, `${key} should not be read`).toBeUndefined();
      expect(out.keyProblem).toBeTruthy();
    }
  });

  test("a malformed wallet is named and yields no target", () => {
    const out = targetFromInput({ wallet: "0x123", key: KEY_ID });
    expect(out.target).toBeUndefined();
    expect(out.walletProblem).toBe("That is not an address.");
  });

  test("no wallet anywhere says so rather than reading a blank one", () => {
    expect(targetFromInput({ wallet: "", key: KEY_ID }).walletProblem).toContain("No wallet in this browser");
  });

  test("an empty key is not an error, it is just nothing to read yet", () => {
    const out = targetFromInput({ wallet: WALLET, key: "" });
    expect(out.target).toBeUndefined();
    expect(out.keyProblem).toBeUndefined();
  });
});
