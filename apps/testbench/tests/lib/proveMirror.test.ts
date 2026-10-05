import { describe, expect, test, vi } from "vitest";
import {
  explainCacheRevert,
  isAnchorRace,
  proveWithRetry,
  type ProveDeps,
  type ProveStatus,
} from "../../src/lib/proveMirror";

const TO = "0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD" as const;
const MISMATCH = "execution reverted: Cache: block header mismatch";

/**
 * A chain whose anchor advances when told to. `anchorDuringBuild` models the
 * race qa hit: the anchor moves while the proof is being built, so the proof is
 * already for a block Celo no longer anchors by the time it is sent.
 */
function deps(opts: {
  anchors: bigint[];
  send?: (n: number) => Promise<{ status: string; transactionHash?: `0x${string}` }>;
}) {
  const reads: bigint[] = [];
  let i = 0;
  let sends = 0;
  const sleep = vi.fn(async () => {});
  const d: ProveDeps = {
    readAnchor: async () => {
      const a = opts.anchors[Math.min(i++, opts.anchors.length - 1)]!;
      reads.push(a);
      return a;
    },
    buildCall: async (anchor) => ({ to: TO, value: 0n, data: "0x01", l1BlockNumber: anchor, provenKeySlot: 1n }),
    send: async () => {
      sends += 1;
      return opts.send ? opts.send(sends) : { status: "CONFIRMED", transactionHash: "0xsent" as const };
    },
    sleep,
  };
  return { d, reads: () => reads, sends: () => sends, sleep };
}

describe("proveWithRetry", () => {
  test("a stable anchor proves first time, with no waiting", async () => {
    const { d, sleep } = deps({ anchors: [100n, 100n] });
    const result = await proveWithRetry(d);
    expect(result).toMatchObject({ status: "CONFIRMED", l1BlockNumber: 100n, attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });

  test("an anchor that moves while building is caught before sending, not after", async () => {
    // qa's failure: the proof was built against 11848081 and the anchor was at
    // 11848101 by the time it landed. Sending it wastes a round trip and a
    // relay fee to learn what a second read tells us for nothing.
    const { d, sends } = deps({ anchors: [100n, 101n, 101n, 101n] });
    const result = await proveWithRetry(d, { maxAttempts: 2 });
    expect(result).toMatchObject({ l1BlockNumber: 101n, attempts: 2 });
    expect(sends(), "the doomed proof is never sent").toBe(1);
  });

  test("it waits between attempts rather than firing both into the same window", async () => {
    // Observed: attempts 1 and 2 failed in quick succession and a third, two
    // minutes later, worked. Whether the cause was the shared window or a slow
    // round trip was never established, so the wait guards one and the
    // re-read before sending guards the other.
    const { d, sleep } = deps({ anchors: [100n, 101n, 101n, 101n] });
    await proveWithRetry(d, { maxAttempts: 2, anchorSettleMs: 60_000 });
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  test("a block header mismatch from the chain is retried, and reported as progress", async () => {
    const seen: ProveStatus[] = [];
    const { d } = deps({
      anchors: [100n, 100n, 100n, 100n],
      send: async (n) => {
        if (n === 1) throw new Error(MISMATCH);
        return { status: "CONFIRMED", transactionHash: "0xsent" };
      },
    });
    const result = await proveWithRetry(d, { maxAttempts: 3, onStatus: (s) => seen.push(s) });
    expect(result.attempts).toBe(2);
    expect(seen.some((s) => s.kind === "anchor-moved")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ kind: "done", transactionHash: "0xsent" });
  });

  test("a revert that is not the anchor race is answered at once, not retried", async () => {
    const { d, sends } = deps({
      anchors: [100n, 100n],
      send: async () => {
        throw new Error("execution reverted: Cache: cannot un-revoke");
      },
    });
    await expect(proveWithRetry(d, { maxAttempts: 3 })).rejects.toThrow(/a revocation is permanent/);
    expect(sends(), "repeating a real answer wastes the operator's time").toBe(1);
  });

  test("a key the anchored block does not carry is refused before anything is sent", async () => {
    const d: ProveDeps = {
      readAnchor: async () => 100n,
      buildCall: async () => ({ to: TO, value: 0n, data: "0x01", l1BlockNumber: 100n, provenKeySlot: 0n }),
      send: vi.fn(),
      sleep: async () => {},
    };
    await expect(proveWithRetry(d)).rejects.toThrow(/does not carry this key yet/);
    expect(d.send).not.toHaveBeenCalled();
  });

  test("giving up says why, and names the wait that would fix it", async () => {
    const { d } = deps({
      anchors: [100n, 100n, 100n, 100n, 100n, 100n],
      send: async () => {
        throw new Error(MISMATCH);
      },
    });
    await expect(proveWithRetry(d, { maxAttempts: 2 })).rejects.toThrow(/did not land in 2 attempts/);
  });

  test("it does not sleep after the final attempt", async () => {
    const { d, sleep } = deps({
      anchors: [100n, 100n, 100n, 100n],
      send: async () => {
        throw new Error(MISMATCH);
      },
    });
    await expect(proveWithRetry(d, { maxAttempts: 2 })).rejects.toThrow();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test("progress names the block being built against, so a wait is legible", async () => {
    const seen: ProveStatus[] = [];
    const { d } = deps({ anchors: [100n, 100n] });
    await proveWithRetry(d, { onStatus: (s) => seen.push(s) });
    expect(seen[0]).toEqual({ kind: "building", attempt: 1, anchorL1Block: 100n });
    expect(seen[1]).toEqual({ kind: "sending", attempt: 1, anchorL1Block: 100n });
  });
});

describe("explainCacheRevert", () => {
  test("the anchor race gets the sentence qa had to work out by hand", () => {
    const said = explainCacheRevert(MISMATCH);
    expect(said).toContain("Cache: block header mismatch");
    expect(said).toContain("lost its window");
  });

  test("every reason the cache raises is explained", () => {
    for (const r of [
      "Cache: call populateKey before isValidKey",
      "Cache: cannot un-revoke",
      "Cache: user is zero",
      "Cache: empty public key",
    ]) {
      expect(explainCacheRevert(r), r).toContain("In other words");
    }
  });

  test("a reason the cache never raises is left alone", () => {
    expect(explainCacheRevert("insufficient funds")).toBe("insufficient funds");
  });
});

describe("isAnchorRace", () => {
  test("only the header mismatch is worth retrying", () => {
    expect(isAnchorRace(MISMATCH)).toBe(true);
    expect(isAnchorRace("Cache: cannot un-revoke")).toBe(false);
  });
});
