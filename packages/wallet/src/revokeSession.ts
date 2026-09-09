import { keccak256, type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import {
  buildPublicClient,
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";
import { buildRevokeKeyCall, readIsValidKey } from "./internal/keystore.js";
import { isCachedRegistry, submitRegistryCalls } from "./internal/cachedRegistry.js";
import type {
  CacheSyncReport,
  RegistryWriteReport,
  Session,
} from "./internal/sessions.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";
import { proveIntoCache } from "./syncSessionToCache.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * What revokeSession returns. On a network with a local KeyStore it is the
 * plain ExecuteResult of the one revoke intent. On a cached network the
 * account revoke is the ExecuteResult, and the two follow-up steps on the
 * registry chain and the cache are reported alongside it.
 */
export type RevokeSessionResult = ExecuteResult & {
  /** Cached networks only: the registry revoke on the registry chain. Reported, never thrown. */
  registry?: RegistryWriteReport;
  /** Cached networks only: the post-revocation proof into the KeyStoreCache. Reported, never thrown. */
  cache?: CacheSyncReport;
};

/**
 * Revoke a session key from a wallet on-chain. After confirmation, the
 * session's next execute attempt fails at validator level.
 *
 * Accepts either a Session object or just the session's public key when
 * you've persisted the session metadata in your app.
 *
 * On a cached network (Celo Sepolia, Celo) the order is: account revoke on
 * the network first (this is what strips the session's power, and it is the
 * only step that throws), then the registry revoke on the registry chain,
 * then a post-revocation proof into the network's cache so third parties
 * reading the cache stop seeing a live key. Steps two and three are reported
 * in the result; a failure there leaves a stale registry or cache entry that
 * `registerSessionKey` cannot fix (revocation is monotonic) but a retry of
 * `revokeSession` or `syncSessionToCache` can.
 */
export async function revokeSession(
  wallet: Wallet,
  adminSigner: Signer,
  sessionOrPublicKey: Session | Hex,
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<RevokeSessionResult> {
  const network = config.network;
  const feeToken = config.feeToken ?? NATIVE_TOKEN;

  const sessionPublicKey =
    typeof sessionOrPublicKey === "string"
      ? sessionOrPublicKey
      : sessionOrPublicKey.publicKey;

  const sessionKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: sessionPublicKey,
    role: "session",
  };

  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  const relayClient = buildRelayClient(network);
  const publicClient = buildPublicClient(network);
  const keyId = keccak256(sessionPublicKey);

  if (isCachedRegistry(network)) {
    return revokeOnCachedNetwork(wallet, adminSigner, sessionPublicKey, keyId, {
      network,
      feeToken,
      sessionKeyDesc,
      adminKeyDesc,
    });
  }

  // Revoke in KeyStore alongside revoking on Porto. KeyStore is the
  // public registry — leaving a revoked session there would be a stale
  // record that other tools would still treat as active. Both ops land in
  // the same userOp. Revocation is monotonic in v1.0.0.
  //
  // Gated on the key actually being registered: sessions granted with
  // `register: false` have no KeyStore entry, and revoking a missing keyId
  // would revert — taking the account-level revoke (the one that removes the
  // session's authority) down with it, since the bundle is atomic.
  const isRegistered = await readIsValidKey(
    publicClient,
    network,
    wallet.address,
    keyId,
  );
  const revokeCalls = isRegistered
    ? [buildRevokeKeyCall({ walletAddress: wallet.address, keyId, network })]
    : [];

  const callsId = await submitCalls(
    relayClient,
    wallet.address,
    adminSigner,
    revokeCalls,
    {
      feeToken,
      submittingKey: adminKeyDesc,
      revokeKeys: [sessionKeyDesc],
      network,
    },
  );

  const result = await waitForCalls(relayClient, callsId);
  return {
    callsId,
    status: result.status as ExecuteResult["status"],
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

async function revokeOnCachedNetwork(
  wallet: Wallet,
  adminSigner: Signer,
  sessionPublicKey: Hex,
  keyId: Hex,
  ctx: {
    network: NetworkConfig & { registry: { kind: "cached"; l1: NetworkConfig; keyStoreCache: Address } };
    feeToken: Address;
    sessionKeyDesc: KeyDescriptor;
    adminKeyDesc: KeyDescriptor;
  },
): Promise<RevokeSessionResult> {
  const { network, feeToken } = ctx;
  const registry = network.registry.l1;
  const relayClient = buildRelayClient(network);

  // 1. Account revoke on the network. The only step that can throw.
  const callsId = await submitCalls(relayClient, wallet.address, adminSigner, [], {
    feeToken,
    submittingKey: ctx.adminKeyDesc,
    revokeKeys: [ctx.sessionKeyDesc],
    network,
  });
  const account = await waitForCalls(relayClient, callsId);
  const base: ExecuteResult = {
    callsId,
    status: account.status as ExecuteResult["status"],
    ...(account.statusCode !== undefined ? { statusCode: account.statusCode } : {}),
    ...(account.transactionHash ? { transactionHash: account.transactionHash } : {}),
  };
  if (account.status !== "CONFIRMED") {
    // The session still has its account authority; nothing downstream is
    // meaningful until that lands.
    return {
      ...base,
      registry: {
        chainId: registry.chainId,
        via: "skipped",
        status: "SKIPPED",
        reason: `account revoke did not confirm (status ${account.status})`,
      },
      cache: {
        chainId: network.chainId,
        status: "SKIPPED",
        reason: `account revoke did not confirm (status ${account.status})`,
      },
    };
  }

  // 2. Registry revoke on the registry chain. Reported, not thrown.
  let registryReport: RegistryWriteReport;
  try {
    const registryClient = buildPublicClient(registry);
    const isRegistered = await readIsValidKey(registryClient, registry, wallet.address, keyId);
    if (!isRegistered) {
      registryReport = {
        chainId: registry.chainId,
        via: "skipped",
        status: "SKIPPED",
        reason: "not registered (or already revoked) on the registry chain",
      };
    } else {
      const written = await submitRegistryCalls({
        network,
        walletAddress: wallet.address,
        adminSigner,
        registryClient,
        calls: [buildRevokeKeyCall({ walletAddress: wallet.address, keyId, network: registry })],
      });
      registryReport = {
        chainId: written.chainId,
        via: written.via,
        status: written.status,
        ...(written.transactionHash ? { transactionHash: written.transactionHash } : {}),
        ...(written.blockNumber !== undefined ? { blockNumber: written.blockNumber } : {}),
      };
    }
  } catch (err) {
    registryReport = {
      chainId: registry.chainId,
      via: registry.relayUrl ? "relay" : "eoa",
      status: "FAILED",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Post-revocation proof into the cache, so the cache stops reporting a
  // live key. Only meaningful once the registry revoke has landed.
  let cacheReport: CacheSyncReport;
  if (registryReport.status === "CONFIRMED") {
    cacheReport = await proveIntoCache(
      wallet,
      adminSigner,
      sessionPublicKey,
      network,
      registryReport.blockNumber,
      feeToken,
    );
  } else {
    cacheReport = {
      chainId: network.chainId,
      status: "SKIPPED",
      reason:
        registryReport.status === "SKIPPED"
          ? "no registry entry to propagate"
          : `registry revoke ${registryReport.status.toLowerCase()}`,
    };
  }

  return { ...base, registry: registryReport, cache: cacheReport };
}
