/**
 * The L2 side of KeyStore authority: proving a registry entry into an L2 cache,
 * and reading what that cache currently says.
 *
 * The KeyStore on Ethereum (or Sepolia) is the only source of truth for which
 * keys an account has authorized. An L2 rooted in it, such as Celo, reads that
 * authority through a `KeyStoreCacheOPStack`, which accepts a proof walking
 * from the L1 block hash the L2's `L1Block` predeploy exposes down to the
 * KeyStore's storage slot for that key. After the proof lands, anything on the
 * L2 can ask the cache `isValidKey(user, keyId)` with one `eth_call`.
 *
 * So an authorize, a timebox or a revoke recorded on the L1 is not yet visible
 * on the L2. It becomes visible when someone relays a proof, which is
 * permissionless: any funded L2 account may relay one for any user, and the
 * relayer gains nothing and can change nothing. That is the step this module
 * encodes, and it keeps the server non-custodial: it returns unsigned calldata
 * and never signs or broadcasts.
 *
 * **Why this file imports the SDK when the rest of the package does not.** The
 * proof depends on the KeyStore's exact storage layout (v1.0.0: `userKeys` at
 * slot 3, the packed liveness word at offset 3 of the `Key` struct). That
 * layout is already written down once, in the SDK's `syncKeyToL2`, alongside the
 * header RLP encoding and the anchor read. A second copy here would be one
 * KeyStore upgrade away from silently building proofs against the wrong slot,
 * and a proof against the wrong slot does not fail loudly: it proves the value
 * of some other word. One copy is worth the dependency. Hosts are unaffected —
 * `bunx @altananetwork/hypersigner-keystore-mcp` resolves it for them — and
 * everything in `./keystore.ts` still needs nothing but viem.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import {
  buildPopulateKeyCall,
  isCachedKeyValid,
  readCachedKey,
  readL1Anchor,
  type CachedKey,
  type L1Anchor,
} from "@altananetwork/sdk";
import { ZERO_ADDRESS, deriveKeyId, type Call, type ChainConfig, type L2CacheConfig } from "./keystore.js";

/**
 * The L2 this server's chain mirrors into, or a refusal saying why there is
 * none. Naming the registry chain directly leaves it unset on purpose: several
 * L2s are rooted in each registry and nothing would say which is meant.
 */
export function requireL2(chain: ChainConfig): L2CacheConfig {
  if (!chain.l2) {
    return failWith(
      `${chain.chain.name} (chainId ${chain.chainId}) holds the KeyStore itself, so there is no ` +
        `cache to prove into from here. Set ALTANA_CHAIN to the L2 whose cache you mean ` +
        `(celo, celo-sepolia): it resolves to this same registry and names the mirror.`,
    );
  }
  if (chain.l2.cache === ZERO_ADDRESS) {
    return failWith(
      `${chain.l2.chain.name} (chainId ${chain.l2.chainId}) has no KeyStoreCache deployed, so an ` +
        `L1 authorization cannot be proven there yet. Its wallets still work: the account enforces ` +
        `permissions and expiry locally, and the cache is the third-party-verifiable record of them.`,
    );
  }
  return chain.l2;
}

function failWith(message: string): never {
  throw new Error(message);
}

/** A public client for the L2, honouring an `L2_RPC_URL` override. */
export function l2Client(l2: L2CacheConfig, rpcUrl?: string): PublicClient {
  return createPublicClient({ chain: l2.chain, transport: http(rpcUrl || l2.rpcUrl) }) as PublicClient;
}

/** What the L2 cache says about a key right now, and whether it is current. */
export type CacheStatus = {
  l2: { key: string; chainId: number; cache: Address };
  user: Address;
  keyId: Hex;
  /** The cache's own verdict: exists, not revoked, not expired, and not stale. */
  valid: boolean;
  /** True when the cache has never been given this key. */
  absent: boolean;
  /** The cached entry, when there is one. */
  cached?: {
    publicKey: Hex;
    revoked: boolean;
    expiry: number;
    isRoot: boolean;
    sourceBlockNumber: bigint;
    sourceBlockHash: Hex;
  };
  /** The L1 block the L2 anchors now. */
  anchor: L1Anchor;
  /**
   * True when the entry was proven against an older L1 block than the one the
   * L2 anchors now. The cache refuses to answer on a stale entry, so the key
   * reads as not valid until a fresh proof lands, even if nothing about it
   * changed on the L1.
   */
  stale: boolean;
  /** What to do next, in one sentence. */
  advice: string;
};

/**
 * Reads the L2 cache for (user, keyId). Distinguishes the three states a caller
 * confuses otherwise: never proven, proven and current, and proven against a
 * block the L2 has moved past.
 */
export async function readCacheStatus(args: {
  chain: ChainConfig;
  user: Address;
  keyId: Hex;
  rpcUrl?: string;
  /** Bring your own L2 client instead of `rpcUrl`, for a custom transport or a test. */
  client?: PublicClient;
}): Promise<CacheStatus> {
  const l2 = requireL2(args.chain);
  const client = args.client ?? l2Client(l2, args.rpcUrl);
  const [entry, anchor, valid] = await Promise.all([
    readCachedKey(client, l2.cache, args.user, args.keyId) as Promise<CachedKey>,
    readL1Anchor(client),
    isCachedKeyValid(client, l2.cache, args.user, args.keyId),
  ]);

  const absent = entry.publicKey === "0x" || entry.sourceBlockNumber === 0n;
  const stale = !absent && entry.sourceBlockNumber < anchor.number;
  return {
    l2: { key: l2.key, chainId: l2.chainId, cache: l2.cache },
    user: args.user,
    keyId: args.keyId,
    valid,
    absent,
    ...(absent
      ? {}
      : {
          cached: {
            publicKey: entry.publicKey,
            revoked: entry.revoked,
            expiry: entry.expiry,
            isRoot: entry.isRoot,
            sourceBlockNumber: entry.sourceBlockNumber,
            sourceBlockHash: entry.sourceBlockHash,
          },
        }),
    anchor,
    stale,
    advice: adviceFor({ absent, valid, stale, revoked: entry.revoked }),
  };
}

function adviceFor(s: { absent: boolean; valid: boolean; stale: boolean; revoked: boolean }): string {
  if (s.absent) {
    return (
      "The cache has never been given this key. Encode a proof with keystore_encode_cache_proof and " +
      "send it on the L2. If the key was registered on the L1 in the last half hour, the L2 may not " +
      "anchor that block yet: compare the registration's block with `anchor.number` above."
    );
  }
  if (s.revoked) {
    return "The cache records this key as revoked, which is final: a revoked key never becomes valid again.";
  }
  if (s.valid) return "The key is valid on the L2 and needs nothing.";
  if (s.stale) {
    return "The entry was proven against an older L1 block than the L2 now anchors, so the cache will not answer for it. Encode a fresh proof and send it.";
  }
  return "The cache has the key but does not consider it valid: it has expired, or it was proven before the L1 authorized it. Check the registry with keystore_get_key.";
}

/** The `populateKey` call, plus what it proves and the window it is valid in. */
export type CacheProof = {
  call: Call;
  l2: { key: string; chainId: number; cache: Address };
  user: Address;
  keyId: Hex;
  /** The L1 block the proof was built against; the cache only takes it while the L2 anchors this block. */
  l1BlockNumber: bigint;
  l1BlockHash: Hex;
  /**
   * The KeyStore's packed liveness word at that block, as proven. Zero means
   * the key did not exist on the L1 there: a registration or revocation always
   * leaves it non-zero, so a zero slot is a proof of absence and the cache
   * refuses it.
   */
  provenKeySlot: bigint;
  warning?: string;
  advice: string;
};

/**
 * Encodes the `populateKey` call that carries this key's current L1 state to the
 * L2 cache. Unsigned, like every other encode tool here: send it from any
 * funded L2 account. It is permissionless and idempotent, and it needs the full
 * public key rather than the keyId, because the cache stores the key itself.
 *
 * The proof is only accepted while the L2 still anchors the L1 block it was
 * built against, so build it and send it in the same breath rather than keeping
 * it.
 */
export async function encodeCacheProof(args: {
  chain: ChainConfig;
  user: Address;
  publicKey: Hex;
  l1Client: PublicClient;
  rpcUrl?: string;
  /** Bring your own L2 client instead of `rpcUrl`, for a custom transport or a test. */
  client?: PublicClient;
}): Promise<CacheProof> {
  const l2 = requireL2(args.chain);
  const client = args.client ?? l2Client(l2, args.rpcUrl);
  const built = await buildPopulateKeyCall({
    l1Client: args.l1Client,
    l2Client: client,
    l1KeyStore: args.chain.keyStore,
    l2Cache: l2.cache,
    user: args.user,
    publicKey: args.publicKey,
  });

  const absentOnL1 = built.provenKeySlot === 0n;
  return {
    call: { to: built.to, value: built.value, data: built.data, chainId: l2.chainId },
    l2: { key: l2.key, chainId: l2.chainId, cache: l2.cache },
    user: args.user,
    keyId: deriveKeyId(args.publicKey),
    l1BlockNumber: built.l1BlockNumber,
    l1BlockHash: built.l1BlockHash,
    provenKeySlot: built.provenKeySlot,
    ...(absentOnL1
      ? {
          warning:
            `At L1 block ${built.l1BlockNumber} this key's KeyStore slot is zero, so the proof says ` +
            `the key does not exist there, and the cache refuses such a proof. Either the key was ` +
            `never registered on the L1, or its registration is newer than the block the L2 anchors. ` +
            `An L2 anchors the L1 with a lag, and on Celo Sepolia that lag is long: the predeploy ` +
            `advances roughly every 20 minutes and trails Sepolia by 15 to 20, so a registration made ` +
            `minutes ago can take close to half an hour to become provable. Wait for the anchor to ` +
            `pass the block holding the registration, then encode again.`,
        }
      : {}),
    advice:
      `Sign and send this on chainId ${l2.chainId} from any funded account; it is permissionless and ` +
      `idempotent. The cache takes it only while the L2 anchors L1 block ${built.l1BlockNumber}, so ` +
      `send it now rather than storing it, and read the result with keystore_cache_status.`,
  };
}
