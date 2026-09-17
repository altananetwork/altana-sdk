import { type Address, type Hex } from "viem";
import { registryNetwork, type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import {
  keyHashForSessionOrKey,
  keyIdForSessionOrKey,
  sessionKeyDescriptor,
} from "./internal/account.js";
import { buildRevokeKeyCall } from "./internal/keystore.js";
import { isCachedRegistry } from "./internal/cachedRegistry.js";
import {
  allLegsSucceeded,
  errorMessage,
  hasCache,
  legFromCacheReport,
  legFromOutcome,
  orderLegs,
  realSessionLegDeps,
  registriesOf,
  settle,
  skippedLeg,
  unknownRegistryBlockReason,
  uniqueNetworks,
  type IntentOutcome,
  type SessionLegDeps,
  launchCacheProofs,
  type CacheGate,
} from "./internal/sessionLegs.js";
import type {
  RevokeLeg,
  RevokeSessionStatus,
  Session,
  SessionLeg,
  SessionStatusDetail,
} from "./internal/sessions.js";
import type { Wallet } from "./internal/types.js";


/**
 * What revokeSession returns.
 *
 * `status` is `revoked` only when every leg confirmed or had nothing to do:
 * no account on the given networks holds the key, no registry lists it as
 * valid, and no cache reports it live. Any failed leg makes it `failed`, and
 * `legs` says which chain and why. Calling revokeSession again is safe and
 * only acts on what is still pending.
 */
export type RevokeSessionResult = {
  /** The session's KeyStore keyId. */
  keyId: Hex;
  status: "revoked" | "failed";
  legs: RevokeLeg[];
  /**
   * The cache legs once every proof has finished. A proof waits for the L2
   * to anchor the Keystore write's block (up to half an hour on Celo
   * Sepolia) and by default runs on after revokeSession returns, its leg
   * reading `PENDING` meanwhile. Never rejects. Until it resolves, that L2's
   * cache still reports the key as valid; the account itself refuses the key
   * as soon as its leg confirmed.
   */
  cacheSync: Promise<RevokeLeg[]>;
};

export type RevokeSessionOptions = {
  /** Every network to revoke on. Only the ones whose account holds the key get an account leg. */
  networks: readonly NetworkConfig[];
  /**
   * Relay fee token on the account legs and cache proofs: one address to force,
   * or a list to pay with the first the relay accepts and the wallet holds.
   * Omitted, the relay charges whichever accepted token the wallet holds.
   */
  feeToken?: Address | readonly Address[];
  onStatus?: (status: RevokeSessionStatus, detail?: SessionStatusDetail) => void;
  /** "await" returns only once every cache proof is in; by default they run on in the background. */
  populateCache?: "await";
};

/**
 * Revoke a session key everywhere it lives.
 *
 * Accepts a Session or just the session's public key when you've persisted
 * the session metadata in your app. Pass the Session for a passkey session:
 * a bare public key is read as secp256k1.
 *
 * 1. Discovery: reads, in parallel, which of `networks` hold the key on the
 *    account, and which of their registry chains list it as valid.
 * 2. Revoke, in parallel: one account leg per network holding the key, and
 *    one registry leg per registry chain that lists it. When the registry
 *    chain is itself a network holding the key (BNB, Ethereum), the registry
 *    revoke rides in that account leg's intent.
 * 3. Cache: for each cached network, once its registry revoke confirmed (and
 *    its own account leg finished), a post-revocation proof into its
 *    KeyStoreCache so third parties reading the cache stop seeing a live key.
 *    A cache still showing the key live after an earlier run is proven again.
 *
 * Never throws for a failed leg. Throws only for an empty `networks`.
 */
export async function revokeSession(
  wallet: Wallet,
  adminSigner: Signer,
  sessionOrPublicKey: Session | Hex,
  options: RevokeSessionOptions,
): Promise<RevokeSessionResult> {
  return runRevokeSession(wallet, adminSigner, sessionOrPublicKey, options, realSessionLegDeps);
}

/** revokeSession with its chain I/O injected. Internal: tests call it with fakes. */
export async function runRevokeSession(
  wallet: Wallet,
  adminSigner: Signer,
  sessionOrPublicKey: Session | Hex,
  options: RevokeSessionOptions,
  deps: SessionLegDeps,
): Promise<RevokeSessionResult> {
  const networks = uniqueNetworks(options.networks);
  if (networks.length === 0) {
    throw new Error("revokeSession: pass at least one network in `networks`.");
  }
  const feeToken = options.feeToken;
  const onStatus = options.onStatus;
  const publicKey =
    typeof sessionOrPublicKey === "string" ? sessionOrPublicKey : sessionOrPublicKey.publicKey;
  const keyId = keyIdForSessionOrKey(sessionOrPublicKey);
  const keyHash = keyHashForSessionOrKey(sessionOrPublicKey);
  const descriptor = sessionKeyDescriptor(sessionOrPublicKey);
  const legs: SessionLeg[] = [];

  // 1. Discovery.
  onStatus?.("discovery");
  const registries = registriesOf(networks);
  const [accountReads, registryReads] = await Promise.all([
    Promise.all(networks.map((n) => settle(deps.accountHasKey(n, wallet.address, keyHash)))),
    Promise.all(registries.map((r) => settle(deps.isValidRegistryKey(r, wallet.address, keyId)))),
  ]);

  const holding: NetworkConfig[] = [];
  networks.forEach((n, i) => {
    const read = accountReads[i]!;
    if ("error" in read) {
      legs.push({
        chainId: n.chainId,
        kind: "account",
        status: "FAILED",
        reason: `could not read the account's keys: ${read.error}`,
      });
    } else if (read.value) {
      holding.push(n);
    }
  });

  // registry chainId -> whether it lists the key (undefined: the read failed).
  const registryValid = new Map<number, boolean>();
  registries.forEach((r, i) => {
    const read = registryReads[i]!;
    if ("error" in read) {
      legs.push({
        chainId: r.chainId,
        kind: "registry",
        status: "FAILED",
        reason: `could not read the registry: ${read.error}`,
      });
    } else {
      registryValid.set(r.chainId, read.value);
      if (!read.value) {
        legs.push(skippedLeg(r.chainId, "registry", "not registered (or already revoked)"));
      }
    }
  });

  // 2. Revoke. A registry that is itself a network holding the key bundles
  // its revoke into that account leg; the rest get a leg of their own.
  const bundled = new Set(
    holding
      .filter((n) => !isCachedRegistry(n) && registryValid.get(n.chainId) === true)
      .map((n) => n.chainId),
  );
  const accountDone = new Map<number, Promise<IntentOutcome>>();
  const registryDone = new Map<number, Promise<IntentOutcome>>();

  for (const n of holding) {
    const bundle = bundled.has(n.chainId);
    onStatus?.("account-revoke", { chainId: n.chainId });
    const done = deps.submitAccountIntent(n, {
      wallet,
      adminSigner,
      calls: bundle ? [buildRevokeKeyCall({ walletAddress: wallet.address, keyId, network: n })] : [],
      ...(feeToken ? { feeToken } : {}),
      revokeKeys: [descriptor],
      needBlockNumber: bundle,
    });
    accountDone.set(n.chainId, done);
    if (bundle) registryDone.set(n.chainId, done);
  }
  const accountLegs = holding.map(async (n) =>
    legFromOutcome(n.chainId, "account", await accountDone.get(n.chainId)!),
  );

  const registryLegs: Promise<SessionLeg>[] = [];
  for (const r of registries) {
    if (registryValid.get(r.chainId) !== true) continue;
    if (bundled.has(r.chainId)) {
      registryLegs.push(
        registryDone.get(r.chainId)!.then((o) => legFromOutcome(r.chainId, "registry", o, "bundled")),
      );
      continue;
    }
    onStatus?.("registry-write", { chainId: r.chainId });
    const done = deps.submitRegistry(r, {
      wallet,
      adminSigner,
      calls: [buildRevokeKeyCall({ walletAddress: wallet.address, keyId, network: r })],
    });
    registryDone.set(r.chainId, done);
    registryLegs.push(done.then((o) => legFromOutcome(r.chainId, "registry", o, o.via)));
  }

  // 3. Cache proofs, per cached network.
  const cacheGates = networks.filter(isCachedRegistry).map(async (n): Promise<CacheGate | undefined> => {
    const l1 = registryNetwork(n).chainId;
    if (!registryValid.has(l1)) return undefined; // registry read failed; already a failed leg

    const ownAccount = accountDone.get(n.chainId);
    const registryWrite = registryDone.get(l1);
    let afterL1Block: bigint | undefined;
    if (registryWrite) {
      const [written] = await Promise.all([registryWrite, ownAccount]);
      if (written.status !== "CONFIRMED") {
        return skippedLeg(n.chainId, "cache", `registry revoke on chain ${l1} did not confirm`);
      }
      if (!hasCache(n)) return skippedLeg(n.chainId, "cache", "no KeyStoreCache configured");
      if (written.blockNumber === undefined) {
        return {
          chainId: n.chainId,
          kind: "cache",
          status: "FAILED",
          reason: unknownRegistryBlockReason(l1, written.blockNumberError),
        };
      }
      afterL1Block = written.blockNumber;
    } else {
      if (!hasCache(n)) return undefined;
      // Registry already clean. Prove again only if this cache still shows the key live.
      let live: boolean;
      try {
        live = await deps.cacheHoldsLiveKey(n, wallet.address, keyId);
      } catch (err) {
        return {
          chainId: n.chainId,
          kind: "cache",
          status: "FAILED",
          reason: `could not read the cache: ${errorMessage(err)}`,
        };
      }
      if (!live) return undefined;
      await ownAccount;
    }
    return {
      chainId: n.chainId,
      prove: async () => {
        onStatus?.("cache-sync", { chainId: n.chainId });
        return legFromCacheReport(await deps.proveIntoCache(wallet, adminSigner, publicKey, n, afterL1Block, feeToken));
      },
    };
  });

  const settled = await Promise.all([
    Promise.all(accountLegs),
    Promise.all(registryLegs),
    Promise.all(cacheGates),
  ]);
  legs.push(...settled[0], ...settled[1]);
  const proofs = launchCacheProofs(settled[2].filter((g): g is CacheGate => g !== undefined));
  legs.push(...(options.populateCache === "await" ? await proofs.cacheSync : proofs.now));

  onStatus?.("done");
  const ordered = orderLegs(legs);
  return { keyId, status: allLegsSucceeded(ordered) ? "revoked" : "failed", legs: ordered, cacheSync: proofs.cacheSync };
}
