/**
 * A nonce lane per signing key: which nonce an intent is given, how two
 * intents of one key sequence, how two keys stay out of each other's way, and
 * what happens when the account cannot be asked.
 *
 * Each test uses its own wallet or key: the lane state is module state and
 * there is deliberately no reset hook.
 */
import { describe, expect, test } from "bun:test";
import { keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import {
  APP_LANE_PREFIX,
  forgetAppLane,
  intendedAppLaneCounter,
  isAppLaneNonce,
  laneForKeyHash,
  laneNonce,
  withAppLaneNonce,
} from "./appNonceLane.js";

const CELO = 11142220;
const BASE = 84532;
const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const keyHash = (label: string) => keccak256(toHex(label));

/**
 * A public client whose `getNonce(lane)` answers from `counters`, or throws for
 * an undelegated account. Records which lanes were asked about.
 */
function fakeClient(counters: Record<string, bigint> | "undelegated") {
  const asked: bigint[] = [];
  const client = {
    async readContract({ args }: { args: readonly unknown[] }) {
      const lane = args[0] as bigint;
      asked.push(lane);
      if (counters === "undelegated") throw new Error("returned no data (0x)");
      return laneNonce(lane, counters[lane.toString(16)] ?? 0n);
    },
  } as unknown as PublicClient;
  return {
    client,
    asked,
    set: (lane: bigint, c: bigint) => {
      if (counters !== "undelegated") counters[lane.toString(16)] = c;
    },
  };
}

describe("the lane a key signs on", () => {
  test("is derived from the key hash, is never 0 and never the multichain prefix", () => {
    for (const label of ["a", "b", "c", "session-1", "admin", ""]) {
      const lane = laneForKeyHash(keyHash(label));
      expect(lane).toBeGreaterThan(0n);
      expect(lane >> 192n).toBe(0n);
      // 0xc1d0 in the top 16 bits would make the account verify a digest with
      // no chain id in it: a different signing scheme, not a label.
      expect(lane >> 176n).not.toBe(0xc1d0n);
      expect(lane >> 176n).toBe(APP_LANE_PREFIX);
      expect(laneNonce(lane, 0n) >> 240n).not.toBe(0xc1d0n);
    }
  });

  test("is the same for the same key and different for different keys", () => {
    expect(laneForKeyHash(keyHash("a"))).toBe(laneForKeyHash(keyHash("a")));
    expect(laneForKeyHash(keyHash("a"))).not.toBe(laneForKeyHash(keyHash("b")));
  });

  test("carries the key, so distinct keys do not crowd into one lane", () => {
    const lanes = new Set(
      Array.from({ length: 200 }, (_, i) => laneForKeyHash(keyHash(`key-${i}`)).toString(16)),
    );
    expect(lanes.size).toBe(200);
  });

  test("a nonce on any app lane is recognisable, and lane 0 is not one", () => {
    const lane = laneForKeyHash(keyHash("a"));
    expect(isAppLaneNonce(laneNonce(lane, 7n))).toBe(true);
    expect(laneNonce(lane, 7n) & ((1n << 64n) - 1n)).toBe(7n);
    expect(isAppLaneNonce(0n)).toBe(false);
    expect(isAppLaneNonce(3n)).toBe(false);
  });
});

describe("the nonce an app transaction is given", () => {
  test("is the account's own counter for that key's lane", async () => {
    const w = wallet(0x11);
    const kh = keyHash("k11");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 5n });
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([laneNonce(lane, 5n)]);
    // It asked about that key's lane, not lane 0.
    expect(fake.asked).toEqual([lane]);
  });

  test("is undefined when the account cannot be asked, so the relay chooses", async () => {
    // A fresh wallet: no delegation yet, the read reverts. The relay gives that
    // first intent a random sequence key, which collides with nothing.
    const w = wallet(0x12);
    const kh = keyHash("k12");
    const fake = fakeClient("undelegated");
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([undefined]);
    expect(intendedAppLaneCounter(CELO, w, laneForKeyHash(kh))).toBeUndefined();
  });

  test("back-to-back transactions of one key get consecutive counters", async () => {
    const w = wallet(0x13);
    const kh = keyHash("k13");
    const lane = laneForKeyHash(kh);
    // The chain does not advance between them: the read-after-write case that
    // makes the relay hand out one nonce twice on lane 0.
    const fake = fakeClient({ [lane.toString(16)]: 0n });
    const seen: (bigint | undefined)[] = [];
    const body = async (n: bigint | undefined) => void seen.push(n);
    for (let i = 0; i < 3; i++) {
      await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, body);
    }
    expect(seen).toEqual([laneNonce(lane, 0n), laneNonce(lane, 1n), laneNonce(lane, 2n)]);
  });

  test("two of ONE key fired at once sequence instead of sharing a nonce", async () => {
    const w = wallet(0x14);
    const kh = keyHash("k14");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 0n });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const inFlight = new Promise<void>((r) => (releaseFirst = r));

    const first = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => {
      order.push(`first:${n! & ((1n << 64n) - 1n)}`);
      await inFlight;
      order.push("first:done");
    });
    const second = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => {
      order.push(`second:${n! & ((1n << 64n) - 1n)}`);
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["first:0"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:0", "first:done", "second:1"]);
  });

  test("two DIFFERENT keys on one wallet fire at once and wait for nothing", async () => {
    // The point of per-key lanes. Two agents, two session keys, one wallet:
    // neither queues behind the other and both take counter 0 of their own
    // lane. This is also why it holds across processes -- each instance only
    // ever advances the lane of the key it holds.
    const w = wallet(0x15);
    const a = keyHash("session-A");
    const b = keyHash("session-B");
    const laneA = laneForKeyHash(a);
    const laneB = laneForKeyHash(b);
    const fake = fakeClient({ [laneA.toString(16)]: 0n, [laneB.toString(16)]: 0n });

    const order: string[] = [];
    let releaseA!: () => void;
    const aInFlight = new Promise<void>((r) => (releaseA = r));

    const runA = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: a }, async (n) => {
      order.push(`A:${n! >> 64n === laneA ? "ownLane" : "wrongLane"}:${n! & ((1n << 64n) - 1n)}`);
      await aInFlight;
    });
    const runB = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: b }, async (n) => {
      order.push(`B:${n! >> 64n === laneB ? "ownLane" : "wrongLane"}:${n! & ((1n << 64n) - 1n)}`);
      return n;
    });

    // B is not behind A: it completes while A is still in flight.
    expect(await runB).toBe(laneNonce(laneB, 0n));
    expect(order).toEqual(["A:ownLane:0", "B:ownLane:0"]);
    releaseA();
    await runA;

    // Separate counters, each advanced only by its own key.
    expect(intendedAppLaneCounter(CELO, w, laneA)).toBe(1n);
    expect(intendedAppLaneCounter(CELO, w, laneB)).toBe(1n);
    expect(laneA).not.toBe(laneB);
  });

  test("one instance losing its state leaves the other key's lane alone", async () => {
    // Two SDK instances, one wallet, a key each. Instance A restarting (which
    // is all `forgetAppLane` is here) must not disturb B's counter, and B must
    // not have to know it happened. That is the property that lets this work
    // across processes at all: nothing is shared, because nothing needs to be.
    const w = wallet(0x1c);
    const a = keyHash("instance-A");
    const b = keyHash("instance-B");
    const laneA = laneForKeyHash(a);
    const laneB = laneForKeyHash(b);
    const fake = fakeClient({ [laneA.toString(16)]: 0n, [laneB.toString(16)]: 0n });
    const fire = (kh: Hex) =>
      withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => n);

    await fire(a);
    await fire(b);
    expect(intendedAppLaneCounter(CELO, w, laneA)).toBe(1n);
    expect(intendedAppLaneCounter(CELO, w, laneB)).toBe(1n);

    // A restarts: it forgets, and re-reads the chain for its own lane only.
    forgetAppLane(CELO, w, laneA);
    expect(intendedAppLaneCounter(CELO, w, laneB)).toBe(1n);

    // A's first transaction after the restart comes from the chain; the chain
    // has A's earlier one mined, so say so.
    fake.set(laneA, 1n);
    expect(await fire(a)).toBe(laneNonce(laneA, 1n));
    // B carries on from where it was, undisturbed.
    expect(await fire(b)).toBe(laneNonce(laneB, 1n));
  });

  test("a chain that has moved on wins over what this process believed", async () => {
    const w = wallet(0x16);
    const kh = keyHash("k16");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 0n });
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async () => {});
    expect(intendedAppLaneCounter(CELO, w, lane)).toBe(1n);

    // Another process used this key's lane: the account is further along.
    fake.set(lane, 9n);
    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([laneNonce(lane, 9n)]);
  });

  test("a failed transaction drops the belief, so the next one re-reads", async () => {
    const w = wallet(0x17);
    const kh = keyHash("k17");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 4n });
    await expect(
      withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async () => {
        throw new Error("InvalidNonce(InvalidNonce)");
      }),
    ).rejects.toThrow("InvalidNonce");
    expect(intendedAppLaneCounter(CELO, w, lane)).toBeUndefined();

    const seen: (bigint | undefined)[] = [];
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => {
      seen.push(n);
    });
    expect(seen).toEqual([laneNonce(lane, 4n)]);
  });

  test("a failure does not wedge the lane for the transaction behind it", async () => {
    const w = wallet(0x18);
    const kh = keyHash("k18");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 0n });
    const failing = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async () => {
      throw new Error("relay down");
    });
    const after = withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => n);
    await expect(failing).rejects.toThrow("relay down");
    expect(await after).toBe(laneNonce(lane, 0n));
  });

  test("a lane's counter is per wallet and per chain as well as per key", async () => {
    const a = wallet(0x19);
    const b = wallet(0x1a);
    const kh = keyHash("k19");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 0n });
    const nonceFor = (w: Address, chainId: number) =>
      withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId, keyHash: kh }, async (n) => n);

    expect(await nonceFor(a, CELO)).toBe(laneNonce(lane, 0n));
    expect(await nonceFor(a, CELO)).toBe(laneNonce(lane, 1n));
    expect(await nonceFor(b, CELO)).toBe(laneNonce(lane, 0n));
    expect(await nonceFor(a, BASE)).toBe(laneNonce(lane, 0n));
    expect(await nonceFor(a, CELO)).toBe(laneNonce(lane, 2n));
  });

  test("forgetting a lane makes the next read authoritative", async () => {
    const w = wallet(0x1b);
    const kh = keyHash("k1b");
    const lane = laneForKeyHash(kh);
    const fake = fakeClient({ [lane.toString(16)]: 0n });
    await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async () => {});
    expect(intendedAppLaneCounter(CELO, w, lane)).toBe(1n);
    forgetAppLane(CELO, w, lane);
    expect(intendedAppLaneCounter(CELO, w, lane)).toBeUndefined();
    expect(
      await withAppLaneNonce({ publicClient: fake.client, wallet: w, chainId: CELO, keyHash: kh }, async (n) => n),
    ).toBe(laneNonce(lane, 0n));
  });
});
