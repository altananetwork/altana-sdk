/**
 * Prove a session key's registry state into a cached network's KeyStoreCache.
 *
 * On Celo Sepolia the KeyStore lives on Sepolia and the Celo Sepolia cache
 * accepts a storage proof against the Sepolia block the L2 currently anchors
 * (through the OP-stack `L1Block` predeploy). This operation waits for the
 * anchor to pass the registry write, builds the proof at that block and
 * executes `populateKey` as a wallet call through the network's own relay:
 * the fee is paid in the network's native token by the wallet, so no
 * separately funded EOA is needed.
 *
 * The cache only accepts a proof for the exact block it anchors right now
 * (about 12 seconds on an OP-stack chain), so a proof can miss its window.
 * The submission is retried against the new anchor up to `maxAttempts`.
 */

import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { type NetworkConfig } from "./config.js";
import { isCachedRegistry, keyStoreCacheOf } from "./internal/cachedRegistry.js";
import {
  buildPublicClient,
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";
import type { Signer } from "./internal/signer.js";
import type { CacheSyncReport, Session } from "./internal/sessions.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";
import {
  buildPopulateKeyCall,
  readCachedKey,
  readL1Anchor,
  waitForL1Anchor,
  type CachedKey,
  type L1Anchor,
} from "./syncKeyToL2.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

export type SyncSessionToCacheStatus =
  | "waiting-for-anchor"
  | "building-proof"
  | "submitting-proof"
  | "retrying"
  | "done";

export type SyncSessionToCacheOptions = {
  /** The cached network (for example CELO_SEPOLIA). Resolved by the client from a chainId. */
  network: NetworkConfig;
  /**
   * The registry-chain block that holds the write being proven. The proof
   * waits until the L2 anchors this block or a later one. Omit to prove the
   * registry state at whatever block the L2 anchors right now.
   */
  afterL1Block?: bigint;
  /** Progress callback; `detail.attempt` counts from 1. */
  onStatus?: (
    status: SyncSessionToCacheStatus,
    detail: { attempt: number; l1BlockNumber?: bigint },
  ) => void;
  /** How many anchors to try before giving up. Default 3. */
  maxAttempts?: number;
  /**
   * Pause after the anchor first passes `afterL1Block` before building the
   * proof, so every backend of a load-balanced RPC (and the relay's) sees the
   * same anchor. Default 60 seconds.
   */
  anchorSettleMs?: number;
  /** Relay fee token on the cached network. Default: native (CELO). */
  feeToken?: Address;
  /** Poll cadence while waiting for the anchor. Default 3s. */
  anchorPollIntervalMs?: number;
  /** Max wait for the anchor to pass `afterL1Block`. Default 30 minutes (Celo Sepolia anchors about every 20 minutes). */
  anchorTimeoutMs?: number;
  /**
   * Public client for the registry chain, used for `eth_getProof` and the
   * header fetch. Defaults to the registry network's `publicRpcUrl`. The
   * endpoint must serve proofs for the anchored block, which is a few blocks
   * behind the registry chain's head; many public Sepolia endpoints only
   * serve the newest block, so pass a client for one that keeps history
   * (see buildPopulateKeyCall for known-good endpoints).
   */
  l1Client?: PublicClient;
};

export type SyncSessionToCacheResult = ExecuteResult & {
  /** The cache entry after the proof landed (or its current state on FAILED). */
  cachedKey: CachedKey;
  /** The registry-chain block the accepted proof was built against. */
  l1BlockNumber: bigint;
  /** The cache the proof went to. */
  keyStoreCache: Address;
  /** Anchors tried, counting the successful one. */
  attempts: number;
};

/**
 * Proves the registry state of a session key (or any public key registered
 * for the wallet) into the cached network's KeyStoreCache, as a wallet call
 * through the network's relay signed by the admin.
 *
 * Works for both directions: a fresh registration and a revocation. After it
 * resolves with CONFIRMED, `isCachedKeyValid` on the cache answers from local
 * state for as long as the L2 keeps anchoring the same registry block; the
 * `getCachedKey` struct keeps the proven status afterwards.
 */
export async function syncSessionToCache(
  wallet: Wallet,
  adminSigner: Signer,
  sessionOrPublicKey: Session | Hex,
  opts: SyncSessionToCacheOptions,
): Promise<SyncSessionToCacheResult> {
  const network = opts.network;
  if (!isCachedRegistry(network)) {
    throw new Error(
      `syncSessionToCache: ${network.chain.name} (chainId ${network.chainId}) keeps its ` +
        `KeyStore locally, so there is no cache to sync. Only cached networks such as ` +
        `CELO_SEPOLIA use it.`,
    );
  }
  const keyStoreCache = keyStoreCacheOf(network);
  const registry = network.registry.l1;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  // Public L2 RPCs are load balanced; around an L1 anchor update their
  // backends can disagree for a minute or two, and the relay simulates on its
  // own backend. Give the new anchor time to propagate before building a
  // proof against it, and back off between mismatch retries.
  const anchorSettleMs = opts.anchorSettleMs ?? 60_000;
  const mismatchBackoffMs = 30_000;
  const feeToken = opts.feeToken ?? NATIVE_TOKEN;

  const publicKey =
    typeof sessionOrPublicKey === "string" ? sessionOrPublicKey : sessionOrPublicKey.publicKey;
  const keyId = keccak256(publicKey);

  const l1Client = opts.l1Client ?? buildPublicClient(registry);
  const l2Client = buildPublicClient(network);
  const relayClient = buildRelayClient(network);

  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) opts.onStatus?.("retrying", { attempt });

    let anchor: L1Anchor;
    if (opts.afterL1Block !== undefined) {
      opts.onStatus?.("waiting-for-anchor", { attempt, l1BlockNumber: opts.afterL1Block });
      anchor = await waitForL1Anchor({
        l1Client,
        l2Client,
        targetL1Block: opts.afterL1Block,
        ...(opts.anchorPollIntervalMs !== undefined
          ? { pollIntervalMs: opts.anchorPollIntervalMs }
          : {}),
        ...(opts.anchorTimeoutMs !== undefined ? { timeoutMs: opts.anchorTimeoutMs } : {}),
        label: "syncSessionToCache",
      });
      if (attempt === 1 && anchorSettleMs > 0) {
        await new Promise((r) => setTimeout(r, anchorSettleMs));
        // Re-read after settling: the anchor may have advanced again.
        anchor = await readL1Anchor(l2Client);
      }
    } else {
      anchor = await readL1Anchor(l2Client);
    }

    opts.onStatus?.("building-proof", { attempt, l1BlockNumber: anchor.number });
    const call = await buildPopulateKeyCall({
      l1Client,
      l2Client,
      l1KeyStore: registry.keyStore,
      l2Cache: keyStoreCache,
      user: wallet.address,
      publicKey,
      anchor,
    });

    opts.onStatus?.("submitting-proof", { attempt, l1BlockNumber: anchor.number });
    let callsId: Hex;
    let status: { status: string; statusCode?: number; transactionHash?: Hex };
    try {
      callsId = await submitCalls(
        relayClient,
        wallet.address,
        adminSigner,
        [{ to: call.to, value: call.value, data: call.data }],
        { feeToken, submittingKey: adminKeyDesc, network },
      );
      status = await waitForCalls(relayClient, callsId);
    } catch (err) {
      // The relay simulates before accepting. A proof built against an anchor
      // the relay's node no longer holds fails that simulation with
      // "Cache: block header mismatch". The relay's RPC and ours can disagree
      // for a few seconds around an anchor update (load-balanced endpoints,
      // 1-second L2 blocks), so retry on that error even when our own read of
      // the anchor looks unchanged; nothing else is worth a retry.
      lastError = err;
      if (attempt < maxAttempts) {
        if (isHeaderMismatch(err)) {
          await new Promise((r) => setTimeout(r, mismatchBackoffMs));
          continue;
        }
        if (await anchorMoved(l2Client, anchor)) continue;
      }
      throw err;
    }

    if (status.status === "CONFIRMED") {
      opts.onStatus?.("done", { attempt, l1BlockNumber: anchor.number });
      const cachedKey = await readCachedKey(l2Client, keyStoreCache, wallet.address, keyId);
      return {
        callsId,
        status: "CONFIRMED",
        ...(status.statusCode !== undefined ? { statusCode: status.statusCode } : {}),
        ...(status.transactionHash ? { transactionHash: status.transactionHash } : {}),
        cachedKey,
        l1BlockNumber: anchor.number,
        keyStoreCache,
        attempts: attempt,
      };
    }

    if (attempt < maxAttempts && (await anchorMoved(l2Client, anchor))) continue;

    const cachedKey = await readCachedKey(l2Client, keyStoreCache, wallet.address, keyId);
    return {
      callsId,
      status: status.status as ExecuteResult["status"],
      ...(status.statusCode !== undefined ? { statusCode: status.statusCode } : {}),
      ...(status.transactionHash ? { transactionHash: status.transactionHash } : {}),
      cachedKey,
      l1BlockNumber: anchor.number,
      keyStoreCache,
      attempts: attempt,
    };
  }

  throw new Error(
    `syncSessionToCache: the L1 anchor moved on every one of ${maxAttempts} attempts; ` +
      `the proof never matched the block ${network.chain.name} anchored at submission time. ` +
      `Retry with a higher maxAttempts or a faster registry-chain RPC.`,
    lastError !== undefined ? { cause: lastError } : undefined,
  );
}

function isHeaderMismatch(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${(err as any).cause?.message ?? ""}` : String(err);
  // The relay renders the revert either as decoded text or as the raw
  // Error(string) payload (selector 0x08c379a0) for "Cache: block header mismatch".
  if (/block header mismatch/i.test(text)) return true;
  const hexReason = Buffer.from("Cache: block header mismatch", "utf8").toString("hex");
  return text.replace(/\s+/g, "").toLowerCase().includes(hexReason);
}

async function anchorMoved(l2Client: PublicClient, used: L1Anchor): Promise<boolean> {
  try {
    const now = await readL1Anchor(l2Client);
    return now.hash.toLowerCase() !== used.hash.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Runs syncSessionToCache and folds the outcome (or the error) into a
 * CacheSyncReport. Shared by grantSession, revokeSession and
 * registerSessionKey, which all report the proof rather than throw on it.
 */
export async function proveIntoCache(
  wallet: Wallet,
  adminSigner: Signer,
  publicKey: Hex,
  network: NetworkConfig,
  afterL1Block: bigint | undefined,
  feeToken: Address,
): Promise<CacheSyncReport> {
  try {
    const synced = await syncSessionToCache(wallet, adminSigner, publicKey, {
      network,
      ...(afterL1Block !== undefined ? { afterL1Block } : {}),
      feeToken,
    });
    return {
      chainId: network.chainId,
      status: synced.status === "CONFIRMED" ? "CONFIRMED" : "FAILED",
      keyStoreCache: synced.keyStoreCache,
      ...(synced.transactionHash ? { transactionHash: synced.transactionHash } : {}),
      l1BlockNumber: synced.l1BlockNumber,
      cachedKey: synced.cachedKey,
      ...(synced.status !== "CONFIRMED"
        ? { reason: `relay status ${synced.status}` + (synced.statusCode !== undefined ? ` (code ${synced.statusCode})` : "") }
        : {}),
    };
  } catch (err) {
    return {
      chainId: network.chainId,
      status: "FAILED",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
