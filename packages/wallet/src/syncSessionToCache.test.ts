/**
 * syncSessionToCache never submits a proof that shows the key absent when the key must exist:
 * it waits for the L2 to anchor a newer L1 block and rebuilds the proof. Chain I/O is injected.
 */
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { runSyncSessionToCache, type SyncSessionToCacheDeps } from "./syncSessionToCache.js";

const WALLET = { address: "0x1111111111111111111111111111111111111111" as Address };
const CACHE_TO = "0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD" as Address;
const REGISTRATION_BLOCK = 11703373n;

function fakeDeps(slots: bigint[]) {
  const log = { built: [] as bigint[], anchorTargets: [] as bigint[], submitted: 0 };
  let anchor = REGISTRATION_BLOCK;
  const deps: SyncSessionToCacheDeps = {
    async waitForL1Anchor(args) {
      log.anchorTargets.push(args.targetL1Block);
      if (anchor < args.targetL1Block) anchor = args.targetL1Block;
      return { hash: ("0x" + anchor.toString(16).padStart(64, "0")) as Hex, number: anchor };
    },
    async readL1Anchor() {
      return { hash: ("0x" + anchor.toString(16).padStart(64, "0")) as Hex, number: anchor };
    },
    async buildPopulateKeyCall(args) {
      const slot = slots[log.built.length] ?? slots[slots.length - 1]!;
      log.built.push(args.anchor!.number);
      return { to: CACHE_TO, value: 0n, data: "0x", l1BlockNumber: args.anchor!.number, l1BlockHash: args.anchor!.hash, provenKeySlot: slot };
    },
    async readCachedKey() {
      return { publicKey: "0x04", revoked: false, expiry: 0, isRoot: false, sourceBlockHash: "0x", sourceBlockNumber: anchor };
    },
    async submitProof() {
      log.submitted++;
      return { callsId: "0xca11" as Hex, status: { status: "CONFIRMED" } };
    },
    async sleep() {},
  };
  return { deps, log };
}

const run = (deps: SyncSessionToCacheDeps, extra: Record<string, unknown> = {}) =>
  runSyncSessionToCache(WALLET, createPrivateKeySigner(), ("0x04" + "11".repeat(64)) as Hex, {
    network: CELO_SEPOLIA,
    afterL1Block: REGISTRATION_BLOCK,
    anchorSettleMs: 0,
    requireKeyInProof: true,
    ...extra,
  }, deps);

describe("proof that shows the key absent", () => {
  test("is not submitted: the next anchor is awaited and the proof rebuilt", async () => {
    const { deps, log } = fakeDeps([0n, 1n]);
    const result = await run(deps);

    expect(log.built).toEqual([REGISTRATION_BLOCK, REGISTRATION_BLOCK + 1n]);
    expect(log.anchorTargets).toContain(REGISTRATION_BLOCK + 1n);
    expect(log.submitted).toBe(1);
    expect(result.status).toBe("CONFIRMED");
    expect(result.l1BlockNumber).toBe(REGISTRATION_BLOCK + 1n);
  });

  test("every proof empty: throws without submitting anything", async () => {
    const { deps, log } = fakeDeps([0n]);
    await expect(run(deps, { maxAttempts: 3 })).rejects.toThrow(/none was submitted/);
    expect(log.submitted).toBe(0);
    expect(log.built).toHaveLength(3);
  });

  test("without requireKeyInProof the proof is submitted as before", async () => {
    const { deps, log } = fakeDeps([0n]);
    const result = await run(deps, { requireKeyInProof: false });
    expect(log.submitted).toBe(1);
    expect(result.status).toBe("CONFIRMED");
  });
});
