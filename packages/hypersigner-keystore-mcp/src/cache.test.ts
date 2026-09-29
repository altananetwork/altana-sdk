/**
 * The L2 cache side: which chains can prove into a cache at all, and the three
 * states a cached key can be in.
 *
 * The state worth testing hardest is the third one. A key that is authorized on
 * the L1 and cached correctly still reads as **not valid** once the L2 anchors a
 * later L1 block than the entry was proven against, because the cache refuses to
 * answer on a stale entry. A caller who does not know that reads "not valid" as
 * "not authorized" and goes looking at the registry, where everything is fine.
 *
 * `eth_getProof` is not mocked: the chain reads go through an injected client,
 * so these run offline.
 */
import { describe, expect, test } from "bun:test";
import type { Address, Hex, PublicClient } from "viem";
import { readCacheStatus, requireL2, type CacheStatus } from "./cache.js";
import { L2_CACHES, resolveChain } from "./keystore.js";

const USER: Address = "0x1111111111111111111111111111111111111111";
const KEY_ID: Hex = `0x${"ab".repeat(32)}`;
const PUBKEY: Hex = `0x04${"11".repeat(32)}${"22".repeat(32)}`;
const CACHE = L2_CACHES["celo-sepolia"]!.cache;

describe("requireL2", () => {
  test("an L2 alias has a cache to prove into", () => {
    expect(requireL2(resolveChain("celo-sepolia")).chainId).toBe(11142220);
  });

  // Naming the registry chain is not a mistake, it just does not say which
  // mirror is meant, and the message says how to say it.
  test("the registry chain's own name says to name the L2 instead", () => {
    for (const name of ["sepolia", "ethereum"]) {
      expect(() => requireL2(resolveChain(name))).toThrow(/holds the KeyStore itself/);
      expect(() => requireL2(resolveChain(name))).toThrow(/celo-sepolia/);
    }
  });

  test("a chain with no KeyStore cache at all says so", () => {
    expect(() => requireL2(resolveChain("bnb"))).toThrow(/holds the KeyStore itself/);
  });

  // Celo mainnet's cache is not deployed. Saying that is much better than
  // encoding a proof to the zero address and having it revert on chain.
  test("an L2 whose cache is not deployed yet says that, and that wallets still work", () => {
    expect(() => requireL2(resolveChain("celo"))).toThrow(/no KeyStoreCache deployed/);
    expect(() => requireL2(resolveChain("celo"))).toThrow(/account enforces/);
  });
});

/** A read-only L2 client: the cache entry, the anchor, and `isValidKey`. */
function fakeL2(o: {
  entry: { publicKey: Hex; revoked: boolean; expiry: number; isRoot: boolean; sourceBlockHash: Hex; sourceBlockNumber: bigint };
  anchorNumber: bigint;
  valid: boolean | (() => never);
}): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getCachedKey":
          return o.entry;
        case "hash":
          return `0x${"cd".repeat(32)}`;
        case "number":
          return o.anchorNumber;
        case "isValidKey":
          if (typeof o.valid === "function") return o.valid();
          return o.valid;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

const absentEntry = {
  publicKey: "0x" as Hex,
  revoked: false,
  expiry: 0,
  isRoot: false,
  sourceBlockHash: `0x${"00".repeat(32)}` as Hex,
  sourceBlockNumber: 0n,
};

const liveEntry = (sourceBlockNumber: bigint, over: Partial<typeof absentEntry> = {}) => ({
  publicKey: PUBKEY,
  revoked: false,
  expiry: 0,
  isRoot: true,
  sourceBlockHash: `0x${"cd".repeat(32)}` as Hex,
  sourceBlockNumber,
  ...over,
});

/** readCacheStatus against Celo Sepolia's config with the chain reads injected. */
function status(client: PublicClient): Promise<CacheStatus> {
  return readCacheStatus({ chain: resolveChain("celo-sepolia"), user: USER, keyId: KEY_ID, client });
}

describe("readCacheStatus", () => {
  test("never proven: absent, not valid, and told to encode a proof", async () => {
    const s = await status(fakeL2({ entry: absentEntry, anchorNumber: 100n, valid: false }));
    expect(s.absent).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.stale).toBe(false);
    expect(s.cached).toBeUndefined();
    expect(s.advice).toContain("keystore_encode_cache_proof");
    expect(s.l2.cache).toBe(CACHE);
    expect(s.anchor.number).toBe(100n);
  });

  test("proven at the anchored block: valid, current, nothing to do", async () => {
    const s = await status(fakeL2({ entry: liveEntry(100n), anchorNumber: 100n, valid: true }));
    expect(s.valid).toBe(true);
    expect(s.absent).toBe(false);
    expect(s.stale).toBe(false);
    expect(s.cached?.publicKey).toBe(PUBKEY);
    expect(s.advice).toContain("needs nothing");
  });

  // The case that reads as "not authorized" and is not.
  test("proven at an older block: stale, and the advice says to re-prove, not to check the registry", async () => {
    const s = await status(fakeL2({ entry: liveEntry(90n), anchorNumber: 100n, valid: false }));
    expect(s.stale).toBe(true);
    expect(s.absent).toBe(false);
    expect(s.valid).toBe(false);
    expect(s.advice).toContain("older L1 block");
    expect(s.advice).toContain("fresh proof");
  });

  // Cache v1.1.0 reverts rather than answering on a stale entry; the SDK's
  // isCachedKeyValid maps that to false, and the status must not blow up.
  test("a cache that reverts on a stale entry still yields a status", async () => {
    const s = await status(
      fakeL2({
        entry: liveEntry(90n),
        anchorNumber: 100n,
        valid: () => {
          throw new Error("execution reverted: call populateKey before isValidKey");
        },
      }),
    );
    expect(s.valid).toBe(false);
    expect(s.stale).toBe(true);
  });

  test("revoked: final, and the advice says so rather than offering a re-proof", async () => {
    const s = await status(fakeL2({ entry: liveEntry(100n, { revoked: true }), anchorNumber: 100n, valid: false }));
    expect(s.cached?.revoked).toBe(true);
    expect(s.valid).toBe(false);
    expect(s.advice).toContain("never becomes valid again");
  });

  test("cached, current and not revoked but still invalid: an expiry, and it says where to look", async () => {
    const s = await status(fakeL2({ entry: liveEntry(100n, { expiry: 1 }), anchorNumber: 100n, valid: false }));
    expect(s.stale).toBe(false);
    expect(s.advice).toContain("expired");
    expect(s.advice).toContain("keystore_get_key");
  });
});
