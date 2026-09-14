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
} from "./internal/sessionLegs.js";
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
 * 1. Registry: one KeyStore write per registry chain, skipped where the key
 *    is already valid. When the registry chain is itself one of `networks`
 *    (BNB, Ethereum) the write rides in that network's account leg.
 * 2. Account: one authorization per network, in parallel. A cached network's
 *    leg waits for its registry chain's write and is skipped if it failed.
 * 3. Cache: for each cached network, the proof of the registry entry into its
 *    KeyStoreCache.
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
  const permissions = await permissionsWithFeeCaps(
    networks,
    opts.permissions,
    feeTokenList(feeToken),
    opts.feeSpendLimit,
  );

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

  registries.forEach((r, i) => {
    const read = registryReads[i]!;
    if ("error" in read) {
      const failed: IntentOutcome = {
        status: "FAILED",
        reason: `could not read the registry: ${read.error}`,
      };
      registryDone.set(r.chainId, Promise.resolve(failed));
      legs.push(legFromOutcome(r.chainId, "registry", failed));
      return;
    }
    if (read.value) {
      legs.push(skippedLeg(r.chainId, "registry", "already registered and valid"));
      return;
    }
    if (execution.has(r.chainId)) {
      bundled.add(r.chainId);
      return;
    }
    onStatus?.("registry-write", { chainId: r.chainId });
    const done = (async () => {
      let fee: bigint;
      try {
        fee = await deps.registrationFee(r);
      } catch (err) {
        return { via: r.relayUrl ? "relay" : "eoa", status: "FAILED", reason: `could not read the registration fee: ${errorMessage(err)}` } as const;
      }
      return deps.submitRegistry(r, { wallet, adminSigner, calls: [registerCall(r, fee)] });
    })();
    registryDone.set(r.chainId, done);
    registryLegs.push(done.then((o) => legFromOutcome(r.chainId, "registry", o, o.via)));
  });

  // 2. Account legs.
  const accountDone = new Map<number, Promise<IntentOutcome | undefined>>();
  for (const n of networks) {
    const bundle = bundled.has(n.chainId);
    // A failed standalone registry write (or registry read) skips the
    // authorization on every network behind that registry.
    const dependsOn = bundle ? undefined : registryDone.get(registryNetwork(n).chainId);
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
  const accountLegs = networks.map(async (n) => {
    const outcome = await accountDone.get(n.chainId)!;
    if (outcome) return legFromOutcome(n.chainId, "account", outcome);
    return skippedLeg(
      n.chainId,
      "account",
      `registry write on chain ${registryNetwork(n).chainId} did not confirm; authorization not attempted`,
    );
  });

  // 3. Cache legs, per cached network.
  const cacheLegs = networks.filter(isCachedRegistry).map(async (n): Promise<SessionLeg> => {
    if (!register) return skippedLeg(n.chainId, "cache", "register: false");
    if (!populate) return skippedLeg(n.chainId, "cache", "populateCache: false");
    if (!hasCache(n)) return skippedLeg(n.chainId, "cache", "no KeyStoreCache configured");
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
    onStatus?.("cache-sync", { chainId: n.chainId });
    return legFromCacheReport(
      await deps.proveIntoCache(wallet, adminSigner, sessionSigner.publicKey, n, written?.blockNumber, feeToken),
    );
  });

  const catchUp = (async () => {
    const outcomes = await Promise.all(accountDone.values());
    if (outcomes.some((o) => o?.status === "CONFIRMED")) await deps.sleep(RELAY_CATCH_UP_MS);
  })();

  const [accounts, registryWrites, caches] = await Promise.all([
    Promise.all(accountLegs),
    Promise.all(registryLegs),
    Promise.all(cacheLegs),
    catchUp,
  ]);
  legs.push(...accounts, ...registryWrites, ...caches);

  onStatus?.("done");
  const ordered = orderLegs(legs);
  return {
    walletAddress: wallet.address,
    signer: sessionSigner,
    publicKey: sessionSigner.publicKey,
    permissions,
    expiry: opts.expiry,
    keyId,
    status: allLegsSucceeded(ordered) ? "granted" : "failed",
    legs: ordered,
  };
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
