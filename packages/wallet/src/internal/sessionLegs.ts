/**
 * The chain I/O a multi-chain grant or revoke performs, behind one interface.
 *
 * grantSession and revokeSession decide which legs run where and in what
 * order; every read and write they make goes through a SessionLegDeps. The
 * public functions use `realSessionLegDeps`; unit tests pass fakes, so the
 * orchestration is tested without mocking the relay module.
 */

import type { Address, Hex } from "viem";
import { registryNetwork, type NetworkConfig } from "../config.js";
import { accountHasKey, getKeys } from "./account.js";
import { isCachedRegistry, keyStoreCacheOf, submitRegistryWrite } from "./cachedRegistry.js";
import type { FeeTokenOption } from "./feeTokenSelection.js";
import { readIsValidKey, readRegistrationFee } from "./keystore.js";
import {
  buildPublicClient,
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type Call,
  type KeyDescriptor,
} from "./relay.js";
import type { CacheSyncReport, SessionLeg } from "./sessions.js";
import type { Signer } from "./signer.js";
import type { Wallet } from "./types.js";
import { readCachedKey } from "../syncKeyToL2.js";
import { proveIntoCache } from "../syncSessionToCache.js";

/** Outcome of one relay intent from the wallet on one chain. */
export type IntentOutcome = {
  status: "CONFIRMED" | "FAILED";
  transactionHash?: Hex;
  /** Only read when asked for (`needBlockNumber`), best effort. */
  blockNumber?: bigint;
  reason?: string;
};

export type SessionLegDeps = {
  accountHasKey(network: NetworkConfig, wallet: Address, keyHash: Hex): Promise<boolean>;
  isValidRegistryKey(registry: NetworkConfig, wallet: Address, keyId: Hex): Promise<boolean>;
  registrationFee(registry: NetworkConfig): Promise<bigint>;
  /** True when the cache on a cached network holds the key unrevoked. */
  cacheHoldsLiveKey(network: NetworkConfig, wallet: Address, keyId: Hex): Promise<boolean>;
  /** One admin-signed intent on `network`. Never throws: failures are an outcome. */
  submitAccountIntent(
    network: NetworkConfig,
    args: {
      wallet: Wallet;
      adminSigner: Signer;
      calls: readonly Call[];
      /** The caller's fee token selector; omitted, the relay picks. */
      feeToken?: FeeTokenOption;
      authorizeKeys?: readonly KeyDescriptor[];
      revokeKeys?: readonly KeyDescriptor[];
      needBlockNumber?: boolean;
    },
  ): Promise<IntentOutcome>;
  /** Registry calls on a registry chain that is not one of the account legs. Never throws. */
  submitRegistry(
    registry: NetworkConfig,
    args: { wallet: Wallet; adminSigner: Signer; calls: readonly Call[] },
  ): Promise<IntentOutcome & { via: "relay" | "eoa" }>;
  proveIntoCache(
    wallet: Wallet,
    adminSigner: Signer,
    publicKey: Hex,
    network: NetworkConfig,
    afterL1Block: bigint | undefined,
    feeToken?: FeeTokenOption,
  ): Promise<CacheSyncReport>;
  /** Waits (bounded) until this process's RPC sees the key on the account. */
  waitForKeyVisible(network: NetworkConfig, wallet: Address, keyHash: Hex): Promise<void>;
  sleep(ms: number): Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const realSessionLegDeps: SessionLegDeps = {
  accountHasKey: (network, wallet, keyHash) =>
    accountHasKey(buildPublicClient(network), wallet, keyHash),

  isValidRegistryKey: (registry, wallet, keyId) =>
    readIsValidKey(buildPublicClient(registry), registry, wallet, keyId),

  registrationFee: (registry) => readRegistrationFee(buildPublicClient(registry), registry),

  async cacheHoldsLiveKey(network, wallet, keyId) {
    if (!isCachedRegistry(network)) return false;
    const cached = await readCachedKey(
      buildPublicClient(network),
      keyStoreCacheOf(network),
      wallet,
      keyId,
    );
    return cached.publicKey !== "0x" && !cached.revoked;
  },

  async submitAccountIntent(network, args) {
    try {
      const relayClient = buildRelayClient(network);
      const callsId = await submitCalls(relayClient, args.wallet.address, args.adminSigner, args.calls, {
        ...(args.feeToken ? { feeToken: args.feeToken } : {}),
        submittingKey: { type: "secp256k1", publicKey: args.adminSigner.publicKey, role: "admin" },
        network,
        ...(args.authorizeKeys ? { authorizeKeys: args.authorizeKeys } : {}),
        ...(args.revokeKeys ? { revokeKeys: args.revokeKeys } : {}),
      });
      const result = await waitForCalls(relayClient, callsId);
      if (result.status !== "CONFIRMED") {
        return {
          status: "FAILED",
          ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
          reason:
            `relay status ${result.status}` +
            (result.statusCode !== undefined ? ` (code ${result.statusCode})` : ""),
        };
      }
      let blockNumber: bigint | undefined;
      if (args.needBlockNumber && result.transactionHash) {
        try {
          const receipt = await buildPublicClient(network).getTransactionReceipt({
            hash: result.transactionHash,
          });
          blockNumber = receipt.blockNumber;
        } catch {
          // The relay confirmed; a lagging public RPC is not a failure of the intent.
        }
      }
      return {
        status: "CONFIRMED",
        ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      };
    } catch (err) {
      return { status: "FAILED", reason: errorMessage(err) };
    }
  },

  async submitRegistry(registry, args) {
    const via = registry.relayUrl ? "relay" : "eoa";
    try {
      const written = await submitRegistryWrite(registry, {
        walletAddress: args.wallet.address,
        adminSigner: args.adminSigner,
        calls: args.calls,
      });
      return {
        via: written.via,
        status: written.status === "CONFIRMED" ? "CONFIRMED" : "FAILED",
        ...(written.transactionHash ? { transactionHash: written.transactionHash } : {}),
        ...(written.blockNumber !== undefined ? { blockNumber: written.blockNumber } : {}),
        ...(written.status !== "CONFIRMED" ? { reason: `registry write status ${written.status}` } : {}),
      };
    } catch (err) {
      return { via, status: "FAILED", reason: errorMessage(err) };
    }
  },

  proveIntoCache,

  async waitForKeyVisible(network, wallet, keyHash) {
    const publicClient = buildPublicClient(network);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const { keyHashes } = await getKeys(publicClient, wallet);
        if (keyHashes.includes(keyHash)) return;
      } catch {
        // Wallet may not be delegated yet on a still-stale read; retry.
      }
      await sleep(500);
    }
    // Timeout: the relay confirmed, but this process's view of the chain never
    // caught up. The key is on-chain regardless.
  },

  sleep,
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A read's value, or its error message. */
export async function settle<T>(p: Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await p };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** Networks deduplicated by chainId, first occurrence kept. */
export function uniqueNetworks(networks: readonly NetworkConfig[]): NetworkConfig[] {
  const seen = new Set<number>();
  return networks.filter((n) => {
    if (seen.has(n.chainId)) return false;
    seen.add(n.chainId);
    return true;
  });
}

/** The registry chains behind a set of networks, one per chain. */
export function registriesOf(networks: readonly NetworkConfig[]): NetworkConfig[] {
  return uniqueNetworks(networks.map(registryNetwork));
}

/** A leg from an intent outcome. */
export function legFromOutcome(
  chainId: number,
  kind: SessionLeg["kind"],
  outcome: IntentOutcome,
  via?: SessionLeg["via"],
): SessionLeg {
  return {
    chainId,
    kind,
    status: outcome.status,
    ...(via ? { via } : {}),
    ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
    ...(outcome.blockNumber !== undefined ? { blockNumber: outcome.blockNumber } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

/** A cache leg from a CacheSyncReport. */
export function legFromCacheReport(report: CacheSyncReport): SessionLeg {
  return {
    chainId: report.chainId,
    kind: "cache",
    status: report.status,
    ...(report.transactionHash ? { transactionHash: report.transactionHash } : {}),
    ...(report.keyStoreCache ? { keyStoreCache: report.keyStoreCache } : {}),
    ...(report.l1BlockNumber !== undefined ? { l1BlockNumber: report.l1BlockNumber } : {}),
    ...(report.cachedKey ? { cachedKey: report.cachedKey } : {}),
    ...(report.reason ? { reason: report.reason } : {}),
  };
}

export function skippedLeg(chainId: number, kind: SessionLeg["kind"], reason: string): SessionLeg {
  return { chainId, kind, status: "SKIPPED", reason };
}

/** True when no leg failed. */
export function allLegsSucceeded(legs: readonly SessionLeg[]): boolean {
  return legs.every((l) => l.status !== "FAILED");
}

/** True when the network's cache address is configured (cached networks only). */
export function hasCache(network: NetworkConfig): boolean {
  if (!isCachedRegistry(network)) return false;
  try {
    keyStoreCacheOf(network);
    return true;
  } catch {
    return false;
  }
}

const LEG_ORDER: Record<SessionLeg["kind"], number> = { account: 0, registry: 1, cache: 2 };

/** Legs ordered account, registry, cache; chain order within a kind as given. */
export function orderLegs(legs: readonly SessionLeg[]): SessionLeg[] {
  return [...legs].sort((a, b) => LEG_ORDER[a.kind] - LEG_ORDER[b.kind]);
}
