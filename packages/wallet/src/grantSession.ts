import { type Address } from "viem";
import { registryNetwork, type NetworkConfig } from "./config.js";
import { keyHashForSigner } from "./internal/erc1271.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import {
  buildRelayClient,
  keyDescriptorFromSigner,
  type Call,
  type KeyDescriptor,
} from "./internal/relay.js";
import { buildAdditionalRegisterCall, deriveKeyId } from "./internal/keystore.js";
import { buildSetCheckerApprovalCall } from "./approveSignatureChecker.js";
import { buildApproveTokenForPermit2Call } from "./approveTokenForPermit2.js";
import { PERMIT2_ADDRESS } from "./internal/x402Rails.js";
import { isCachedRegistry } from "./internal/cachedRegistry.js";
import { fetchFeeCurrencies, type FeeCurrency } from "./internal/feeCurrencies.js";
import { addFeeSpendCaps, feeTokenList } from "./internal/feeTokenSelection.js";
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
import { withDefaultCallPermissions } from "./internal/sessions.js";
import type {
  GrantSessionOptions,
  GrantSessionResult,
  SessionLeg,
  SessionPermissions,
} from "./internal/sessions.js";
import type { Wallet } from "./internal/types.js";


/**
 * After every account leg confirms and this process sees the key, give the
 * relay's own RPC pool time to catch up: load-balanced public RPCs (BSC
 * notably) serve independent caches, and the relay's view can lag ours by
 * about 10s, which would fail the session's first execute with "unknown key
 * hash".
 */
const RELAY_CATCH_UP_MS = 12_000;

// Warn once per process: an SDK-generated session key lives only in memory,
// and the grant it backs is a live on-chain authorization. Losing the key
// (a crash, a script ending) strands that authorization until an admin
// revokes it — the exact failure reported in issue #58.
let warnedEphemeralSigner = false;
function ephemeralSessionSigner(): Signer {
  if (!warnedEphemeralSigner) {
    warnedEphemeralSigner = true;
    console.warn(
      "[altana-sdk] grantSession was called without a sessionSigner, so the SDK generated " +
        "an ephemeral key that exists only in this process's memory. If it is lost before " +
        "you persist it, the on-chain authorization it backs becomes permanently unusable " +
        "(revoke-and-regrant is the only exit). Prefer generating your own key, storing it " +
        "in a secret store, and passing sessionSigner: signerFromPrivateKey(key); persist " +
        "the rest with serializeSession(session).",
    );
  }
  return createPrivateKeySigner();
}

export type GrantSessionConfig = {
  /** Every network to authorize the session on. */
  networks: readonly NetworkConfig[];
  /**
   * Relay fee token on the account legs and cache proofs: one address to
   * force it, or a list to pay with the first the relay accepts and the
   * wallet holds. Each named token also gets a daily spend cap in the
   * session's permissions (see `feeSpendLimit`). Omitted, the relay charges
   * whichever accepted token the wallet holds.
   */
  feeToken?: Address | readonly Address[];
};

/**
 * Grant a scoped session key for a wallet on every network given. The admin
 * signer authorizes the session on-chain; from that point forward the
 * session can act on the wallet within its permissions/expiry, enforced by
 * the Altana account contract validator on each chain.
 *
 * Pass the returned Session to whichever process runs the agent. The agent
 * calls execute(session, calls) — never the admin.
 *
 * 1. Account: one authorization per network, in parallel. On a network with a
 *    cached registry (Celo) this goes FIRST and waits for nothing, so the key
 *    is usable as soon as this call returns.
 * 2. Registry: one KeyStore write per registry chain, skipped where the key is
 *    already valid. When the registry chain is itself one of `networks` (BNB,
 *    Ethereum) the write rides in that network's account leg. Behind a cached
 *    network the write runs in the BACKGROUND after that network's
 *    authorization confirms: its leg reads `PENDING` in `legs` and resolves
 *    through `result.registration`.
 * 3. Cache: for each cached network, the proof of the registry entry into its
 *    KeyStoreCache. It needs the write's block, so it chains after (2).
 *
 * A network with no cached registry is unchanged: its authorization still
 * waits for the registry write and is skipped if that failed.
 *
 * Never throws for a failed leg: check `result.status`. Throws only for an
 * empty `networks`.
 */
export async function grantSession(
  wallet: Wallet,
  adminSigner: Signer,
  opts: GrantSessionOptions,
  config: GrantSessionConfig,
): Promise<GrantSessionResult> {
  return runGrantSession(wallet, adminSigner, opts, config, realSessionLegDeps);
}

/** grantSession with its chain I/O injected. Internal: tests call it with fakes. */
export async function runGrantSession(
  wallet: Wallet,
  adminSigner: Signer,
  opts: GrantSessionOptions,
  config: GrantSessionConfig,
  deps: SessionLegDeps,
): Promise<GrantSessionResult> {
  const networks = uniqueNetworks(config.networks);
  if (networks.length === 0) {
    throw new Error("grantSession: pass at least one network in `networks`.");
  }
  // Undefined lets the relay charge whichever accepted token the wallet holds.
  const feeToken = config.feeToken;
  const onStatus = opts.onStatus;
  const sessionSigner = opts.sessionSigner ?? ephemeralSessionSigner();
  const keyId = deriveKeyId(sessionSigner.publicKey);
  const keyHash = keyHashForSigner(sessionSigner);

  // The tokens the session may pay relay fees in must sit inside its spend
  // cap, or the relay rejects its transactions later. Each named fee token
  // gets a daily cap unless the caller capped it already; the returned
  // Session carries these effective permissions, which execute must match.
  // Omitting `calls` promises every target, so turn that promise into the
  // account's ANY_TARGET wildcard before anything is signed. Without this the
  // session is authorized for no target at all and is refused with
  // UnauthorizedCall the first time the agent acts, with nothing connecting the
  // failure back to the grant.
  const permissions = await permissionsWithFeeCaps(
    networks,
    withDefaultCallPermissions(opts.permissions),
    feeTokenList(feeToken),
    opts.feeSpendLimit,
  );

  // The approvals an x402 payment needs, if the caller said the session will
  // make one. They ride in the same intent as the key authorization: the relay
  // applies `authorizeKeys` before the intent's own calls, so the key exists by
  // the time `setSignatureCheckerApproval` runs (it reverts `KeyDoesNotExist()`
  // otherwise). Measured live on Celo Sepolia, tx 0x178d30ee…99382.
  const x402Calls: Call[] = (opts.x402Tokens ?? []).flatMap((token): Call[] => [
    // Permit2 moves the token with an ordinary transferFrom.
    buildApproveTokenForPermit2Call(token),
    // The token calls isValidSignature itself on the eip3009 rail.
    { ...buildSetCheckerApprovalCall({ wallet: wallet.address, keyHash, checker: token, isApproved: true }) },
  ]);
  if (x402Calls.length > 0) {
    // Permit2 calls back on the permit2 rail; once, not per token.
    x402Calls.push(
      buildSetCheckerApprovalCall({ wallet: wallet.address, keyHash, checker: PERMIT2_ADDRESS, isApproved: true }),
    );
  }

  // Session key descriptor — secp256k1 or passkey (WebAuthnP256), by signer.
  const descriptor: KeyDescriptor = keyDescriptorFromSigner(sessionSigner, {
    role: "session",
    expiry: opts.expiry,
    permissions,
  });

  // Register the session's public key in KeyStore alongside the account
  // authorization (default). KeyStore is the public registry that lets ANY
  // tool/agent verify this session. `register: false` skips the registry
  // entry (and the fee) for ephemeral sessions; the account-level
  // authorization is unaffected, and the key can be registered later with
  // registerSessionKey.
  const register = opts.register !== false;
  const populate = opts.populateCache !== false;
  const awaitCache = opts.populateCache === "await";
  const legs: SessionLeg[] = [];
  const registerCall = (network: NetworkConfig, fee: bigint): Call =>
    buildAdditionalRegisterCall({
      publicKey: sessionSigner.publicKey,
      fee,
      network,
      expiry: opts.expiry,
    });

  // 1. Registry state, per registry chain.
  const registries = register ? registriesOf(networks) : [];
  const registryReads = await Promise.all(
    registries.map((r) => settle(deps.isValidRegistryKey(r, wallet.address, keyId))),
  );
  // registry chainId -> write outcome; absent when nothing needs writing.
  const registryDone = new Map<number, Promise<IntentOutcome>>();
  // registry chains that are themselves one of `networks` and need the write.
  const bundled = new Set<number>();
  const registryLegs: Promise<SessionLeg>[] = [];
  const execution = new Set(networks.map((n) => n.chainId));

  // Cached networks, by the registry chain behind them, excluding a registry
  // chain that is itself one of `networks` (there the write rides that chain's
  // own account leg, on its own nonce, and nothing has to be sequenced).
  //
  // These are the networks that authorize FIRST: the account enforces the key
  // locally, so the authorization needs nothing from the KeyStore, and making
  // it wait for an L1 confirmation left the session unusable for as long as
  // that took. Their registry write becomes background work instead.
  const cachedBehind = new Map<number, NetworkConfig[]>();
  for (const n of networks) {
    if (!isCachedRegistry(n)) continue;
    const l1 = registryNetwork(n).chainId;
    if (execution.has(l1)) continue;
    const list = cachedBehind.get(l1);
    if (list) list.push(n);
    else cachedBehind.set(l1, [n]);
  }

  // A deferred write cannot be built until the account legs exist, and the
  // account legs of networks that still depend on a registry write cannot be
  // built until the write promise exists. This gate breaks the knot: the
  // deferred writes are created now and start looking at `accountDone` only
  // once every leg has been put there.
  let openGate!: () => void;
  const accountLegsBuilt = new Promise<void>((r) => {
    openGate = r;
  });

  /** A deferred write that never ran, with the reason it was not attempted. */
  type NotAttempted = { notAttempted: string };
  type DeferredWrite = NotAttempted | (IntentOutcome & { via?: SessionLeg["via"] });
  const deferredLegs: Promise<SessionLeg>[] = [];
  /** Registry chains whose write was actually deferred, so it is still running. */
  const deferredChains = new Set<number>();
  /** Registry legs settled here and now, for `registration` to report too. */
  const decidedRegistryLegs: SessionLeg[] = [];

  /** The write itself, once something has decided it should happen. */
  const runWrite = async (r: NetworkConfig): Promise<IntentOutcome & { via?: SessionLeg["via"] }> => {
    // Kept unconditional so a consumer still sees the event when the write
    // fails before any intent is attempted, or when a dep reports no steps.
    onStatus?.("registry-write", { chainId: r.chainId });
    let fee: bigint;
    try {
      fee = await deps.registrationFee(r);
    } catch (err) {
      return {
        via: r.relayUrl ? "relay" : "eoa",
        status: "FAILED",
        reason: `could not read the registration fee: ${errorMessage(err)}`,
      };
    }
    // A first-time write is two intents; the step says which one is running.
    // The event name is unchanged, so a consumer ignoring `step` sees
    // `registry-write` twice, which is what actually happens.
    return deps.submitRegistry(r, {
      wallet,
      adminSigner,
      calls: [registerCall(r, fee)],
      onStep: (step) => onStatus?.("registry-write", { chainId: r.chainId, step }),
    });
  };

  registries.forEach((r, i) => {
    const read = registryReads[i]!;
    if ("error" in read) {
      const failed: IntentOutcome = {
        status: "FAILED",
        reason: `could not read the registry: ${read.error}`,
      };
      registryDone.set(r.chainId, Promise.resolve(failed));
      const leg = legFromOutcome(r.chainId, "registry", failed);
      legs.push(leg);
      decidedRegistryLegs.push(leg);
      return;
    }
    if (read.value) {
      const leg = skippedLeg(r.chainId, "registry", "already registered and valid");
      legs.push(leg);
      decidedRegistryLegs.push(leg);
      return;
    }
    if (execution.has(r.chainId)) {
      bundled.add(r.chainId);
      return;
    }
    const first = cachedBehind.get(r.chainId);
    if (!first) {
      // No cached network behind this registry: the write still goes first and
      // the authorizations behind it wait, exactly as before.
      const done = runWrite(r);
      registryDone.set(r.chainId, done);
      registryLegs.push(done.then((o) => legFromOutcome(r.chainId, "registry", o, o.via)));
      return;
    }

    // Deferred. The write is paid by an intent from the wallet's account on
    // one of these same L2s, and the relay reserves no nonce for an intent it
    // has not mined (evidence/2026-09-28-back-to-back-race-attribution.md), so
    // starting it while an authorization is in flight on that chain would make
    // the two read the same nonce. Waiting for the authorizations to settle is
    // what keeps them off each other — not a delay for its own sake.
    deferredChains.add(r.chainId);
    const write = (async (): Promise<DeferredWrite> => {
      await accountLegsBuilt;
      const outcomes = await Promise.all(first.map((n) => accountDone.get(n.chainId)!));
      if (!outcomes.some((o) => o?.status === "CONFIRMED")) {
        return {
          notAttempted:
            `no account authorization confirmed on ${first.map((n) => n.chainId).join(", ")}, ` +
            `so the KeyStore write was not attempted`,
        };
      }
      return runWrite(r);
    })();

    registryDone.set(
      r.chainId,
      write.then((w) => ("notAttempted" in w ? { status: "FAILED", reason: w.notAttempted } : w)),
    );
    deferredLegs.push(
      write.then((w) => {
        if ("notAttempted" in w) return skippedLeg(r.chainId, "registry", w.notAttempted);
        if (w.status !== "CONFIRMED") {
          onStatus?.("registry-write-failed", {
            chainId: r.chainId,
            ...(w.reason ? { reason: w.reason } : {}),
          });
        }
        return legFromOutcome(r.chainId, "registry", w, w.via);
      }),
    );
  });

  // 2. Account legs.
  const accountDone = new Map<number, Promise<IntentOutcome | undefined>>();
  for (const n of networks) {
    const bundle = bundled.has(n.chainId);
    // A failed standalone registry write (or registry read) skips the
    // authorization on every network behind that registry — except on a
    // network with a cached registry, which authorizes first and waits for
    // nothing. There the account is the authority on whether the key may act;
    // the KeyStore entry is the public record of it, and a missing record
    // makes the session unverifiable by third parties, not unusable.
    const dependsOn =
      bundle || isCachedRegistry(n) ? undefined : registryDone.get(registryNetwork(n).chainId);
    const done = (async (): Promise<IntentOutcome | undefined> => {
      if (dependsOn && (await dependsOn).status !== "CONFIRMED") return undefined;
      let calls: Call[] = [];
      if (bundle) {
        try {
          calls = [registerCall(n, await deps.registrationFee(n))];
        } catch (err) {
          return { status: "FAILED", reason: `could not read the registration fee: ${errorMessage(err)}` };
        }
      }
      // Per chain, like the authorization: the account's approvals are its own
      // storage on each one.
      calls = [...calls, ...x402Calls];
      onStatus?.("account-authorization", { chainId: n.chainId });
      const outcome = await deps.submitAccountIntent(n, {
        wallet,
        adminSigner,
        calls,
        ...(feeToken ? { feeToken } : {}),
        authorizeKeys: [descriptor],
        needBlockNumber: bundle,
      });
      if (outcome.status === "CONFIRMED") {
        await deps.waitForKeyVisible(n, wallet.address, keyHash);
      }
      return outcome;
    })();
    accountDone.set(n.chainId, done);
    if (bundle) {
      registryDone.set(
        n.chainId,
        done.then((o) => o ?? { status: "FAILED", reason: "account leg not attempted" }),
      );
      registryLegs.push(
        done.then((o) =>
          o
            ? legFromOutcome(n.chainId, "registry", o, "bundled")
            : skippedLeg(n.chainId, "registry", "account leg not attempted"),
        ),
      );
    }
  }
  // Every leg is in `accountDone`: the deferred writes may look at it now.
  openGate();

  const accountLegs = networks.map(async (n) => {
    const outcome = await accountDone.get(n.chainId)!;
    if (outcome) return legFromOutcome(n.chainId, "account", outcome);
    return skippedLeg(
      n.chainId,
      "account",
      `registry write on chain ${registryNetwork(n).chainId} did not confirm; authorization not attempted`,
    );
  });

  // 3. Cache legs, per cached network. The gate settles with the legs before
  // it; the proof waits for the L2 to anchor the registry block and runs on
  // after the grant returns unless the caller asked to wait.

  /** Decided without waiting for anything, so it is reported at return. */
  const staticCacheSkip = (n: NetworkConfig): SessionLeg | undefined => {
    if (!register) return skippedLeg(n.chainId, "cache", "register: false");
    if (!populate) return skippedLeg(n.chainId, "cache", "populateCache: false");
    if (!hasCache(n)) return skippedLeg(n.chainId, "cache", "no KeyStoreCache configured");
    return undefined;
  };

  const cacheGate = async (n: NetworkConfig): Promise<CacheGate> => {
    const l1 = registryNetwork(n).chainId;
    const [account, written] = await Promise.all([accountDone.get(n.chainId)!, registryDone.get(l1)]);
    if (!account || account.status !== "CONFIRMED") {
      return skippedLeg(n.chainId, "cache", "account authorization did not confirm");
    }
    if (written && written.status !== "CONFIRMED") {
      return skippedLeg(n.chainId, "cache", `registry write on chain ${l1} did not confirm`);
    }
    // A write happened: the proof must wait for the L2 to anchor its block. Without the block,
    // do not prove at all. (No write means the key was already valid; proving now is correct.)
    if (written && written.blockNumber === undefined) {
      return {
        chainId: n.chainId,
        kind: "cache",
        status: "FAILED",
        reason: unknownRegistryBlockReason(l1, written.blockNumberError),
      };
    }
    return {
      chainId: n.chainId,
      prove: async () => {
        onStatus?.("cache-sync", { chainId: n.chainId });
        return legFromCacheReport(
          await deps.proveIntoCache(wallet, adminSigner, sessionSigner.publicKey, n, written?.blockNumber, feeToken),
        );
      },
    };
  };

  // One slot per cached network, in `networks` order so every list below
  // agrees. A slot whose registry write was deferred cannot know its outcome
  // before this call returns, so it reads PENDING and resolves in `cacheSync`.
  const cacheSlots = networks.filter(isCachedRegistry).map((n) => {
    const skip = staticCacheSkip(n);
    // Deferred only when a write for this registry really was deferred. A
    // registry that needed no write (key already valid) or whose write rode an
    // account intent settles here, as it always did.
    const deferred = !skip && deferredChains.has(registryNetwork(n).chainId);
    return { network: n, skip, deferred, gate: skip || deferred ? undefined : cacheGate(n) };
  });

  const catchUp = (async () => {
    const outcomes = await Promise.all(accountDone.values());
    if (outcomes.some((o) => o?.status === "CONFIRMED")) await deps.sleep(RELAY_CATCH_UP_MS);
  })();

  // The registry legs, final: the ones already decided, the ones riding an
  // account intent, and the deferred writes once they land. Never rejects.
  const registration = (async (): Promise<SessionLeg[]> => {
    const [running, deferred] = await Promise.all([
      Promise.all(registryLegs),
      Promise.all(deferredLegs),
    ]);
    return [...decidedRegistryLegs, ...running, ...deferred];
  })();

  const gated = cacheSlots.filter((s) => s.gate);
  const [accounts, registryWrites, settledGates] = await Promise.all([
    Promise.all(accountLegs),
    Promise.all(registryLegs),
    Promise.all(gated.map((s) => s.gate!)),
    catchUp,
  ]);

  // Proofs whose gate settled before returning start together, as they always
  // have. A deferred slot starts its own once its registry write has landed.
  const settledProofs = launchCacheProofs(settledGates);
  const settledNow = new Map(gated.map((s, i) => [s.network.chainId, settledProofs.now[i]!]));

  const slotLegs = cacheSlots.map((s) => {
    if (s.skip) return { now: s.skip, final: Promise.resolve(s.skip) };
    if (!s.deferred) {
      const now = settledNow.get(s.network.chainId)!;
      const final = settledProofs.cacheSync.then(
        (all) => all.find((l) => l.chainId === s.network.chainId) ?? now,
      );
      return { now, final };
    }
    const final = (async () => {
      const gate = await cacheGate(s.network);
      const [leg] = await launchCacheProofs([gate]).cacheSync;
      return leg!;
    })();
    const now: SessionLeg = { chainId: s.network.chainId, kind: "cache", status: "PENDING" };
    return { now, final };
  });

  const cacheSync = Promise.all(slotLegs.map((l) => l.final));

  // `await` means the caller wants the finished picture, and a cache proof
  // cannot finish before the registry write it proves: waiting for the proofs
  // means waiting for the registration too. Only the DEFERRED legs are taken
  // from it — the rest are already in `legs` and `registryWrites`.
  const [caches, deferredFinal] = awaitCache
    ? await Promise.all([cacheSync, Promise.all(deferredLegs)])
    : [slotLegs.map((l) => l.now), deferredPendingLegs()];
  legs.push(...accounts, ...registryWrites, ...deferredFinal, ...caches);

  onStatus?.("done");
  const ordered = orderLegs(legs);
  return {
    walletAddress: wallet.address,
    signer: sessionSigner,
    publicKey: sessionSigner.publicKey,
    permissions,
    expiry: opts.expiry,
    keyId,
    keyHash,
    status: allLegsSucceeded(ordered) ? "granted" : "failed",
    legs: ordered,
    cacheSync,
    registration,
  };

  /** The deferred registry writes as they read at return: still running. */
  function deferredPendingLegs(): SessionLeg[] {
    return [...deferredChains].map((chainId) => ({ chainId, kind: "registry", status: "PENDING" }));
  }
}

/**
 * The session permissions with a daily spend cap on each fee token, so the
 * session can pay relay fees in it (see `addFeeSpendCaps`). A token must be
 * one the relay accepts on at least one of the networks granted on: a wallet
 * pays fees on each chain in that chain's own tokens.
 */
async function permissionsWithFeeCaps(
  networks: readonly NetworkConfig[],
  permissions: SessionPermissions,
  feeTokens: readonly Address[],
  limit?: bigint,
): Promise<SessionPermissions> {
  if (feeTokens.length === 0) return permissions;
  const relayed = networks.filter((n) => n.relayUrl);
  const lists = await Promise.all(relayed.map((n) => fetchFeeCurrencies(buildRelayClient(n), n)));
  const accepted: FeeCurrency[] = [];
  for (const { currencies } of lists) {
    for (const c of currencies) {
      if (!accepted.some((a) => a.address.toLowerCase() === c.address.toLowerCase())) accepted.push(c);
    }
  }
  for (const token of feeTokens) {
    if (accepted.some((c) => c.address.toLowerCase() === token.toLowerCase())) continue;
    throw new Error(
      `${token} is not a fee token the relay accepts on any of the chains granted on ` +
        `(${relayed.map((n) => n.chain.name).join(", ")}); a session cannot pay fees in it. ` +
        `Accepted: ${accepted.map((c) => c.symbol).join(", ")}.`,
    );
  }
  return addFeeSpendCaps(permissions, feeTokens, accepted, relayed[0] ?? networks[0]!, limit);
}
