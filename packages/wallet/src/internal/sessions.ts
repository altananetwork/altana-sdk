/**
 * Session-key types and helpers.
 *
 * A Session is a scoped, time-bounded delegation from a wallet's admin
 * signer to another key. The session key is enforced on-chain by the
 * Altana account contract: calls outside the granted permissions revert
 * at validation time. Revocation is a single tx; effect is immediate.
 *
 * Permission types mirror Porto's schema (signature-scheme agnostic).
 */

import type { Address, Hex } from "viem";
import type { Signer } from "./signer.js";
import type { CachedKey } from "../syncKeyToL2.js";

/** A single allowed call rule. AND semantics between the optional fields. */
export type CallPermission =
  | { signature: string; to: Address }
  | { signature: string }
  | { to: Address };

/** A spending cap for a token over a rolling period. */
export type SpendPermission = {
  limit: bigint;
  period: "minute" | "hour" | "day" | "week" | "month" | "year";
  /** Omit for native token (ETH). */
  token?: Address;
};

export type SessionPermissions = {
  /** Allowed calls. If omitted, all targets are allowed (use carefully). */
  calls?: readonly CallPermission[];
  /** Per-token spending caps. */
  spend?: readonly SpendPermission[];
};

/**
 * A live session — the result of grantSession. Carries everything an agent
 * needs to act on the wallet within the granted scope.
 *
 * The integrator hands this object to whichever process runs the agent;
 * the agent uses it with execute(session, calls).
 */
export type Session = {
  /** The wallet this session can act on. */
  walletAddress: Address;
  /** The session key's signer. Agent signs with this. */
  signer: Signer;
  /** Public key registered on-chain. Identifier for revocation. */
  publicKey: Hex;
  /** Granted permissions (also enforced on-chain). */
  permissions: SessionPermissions;
  /** Unix epoch seconds when this session expires. */
  expiry: number;
};

/**
 * One step of a multi-chain grant or revoke, on one chain.
 *
 * - `account`: the key authorized on (or revoked from) the account on `chainId`.
 * - `registry`: the KeyStore write on the registry chain `chainId`. `via:
 *   "bundled"` means it rode in the account leg's intent on the same chain,
 *   with the same transaction hash.
 * - `cache`: the proof of the registry state into the KeyStoreCache on the
 *   cached network `chainId`.
 *
 * `SKIPPED` means there was nothing to do (already registered, not
 * registered, no cache configured) or a leg it depends on did not confirm;
 * `reason` says which.
 */
export type SessionLeg = {
  chainId: number;
  kind: "account" | "registry" | "cache";
  status: "CONFIRMED" | "FAILED" | "SKIPPED";
  /** Registry legs: how the write reached the registry chain. */
  via?: "relay" | "eoa" | "bundled";
  transactionHash?: Hex;
  /** Registry legs: the block the write landed in. */
  blockNumber?: bigint;
  /** Registry legs: the L2 whose balance paid for the write, when the relay funded it from there. */
  fundedFromChainId?: number;
  /** Registry legs: the source-chain transaction that locked the funds. */
  sourceTransactionHash?: Hex;
  /** Cache legs: the cache the proof went to. */
  keyStoreCache?: Address;
  /** Cache legs: the registry-chain block the accepted proof was built against. */
  l1BlockNumber?: bigint;
  /** Cache legs: the cache entry after the proof, when one was read. */
  cachedKey?: CachedKey;
  /** Why the leg was skipped or failed. */
  reason?: string;
};

/** A leg of revokeSession. */
export type RevokeLeg = SessionLeg;
/** A leg of grantSession. */
export type GrantLeg = SessionLeg;

/**
 * What grantSession returns: the Session, plus how the grant went on every
 * chain it was asked for.
 *
 * `status` is `granted` only when every leg confirmed or had nothing to do.
 * Any failed leg makes it `failed`, and `legs` says which chain and why.
 * Granting again with the same `sessionSigner` is safe: a key already in the
 * registry is not written twice.
 *
 * Assignable to Session. Check `status` before handing the session to an agent.
 */
export type GrantSessionResult = Session & {
  /** The session's KeyStore keyId. */
  keyId: Hex;
  status: "granted" | "failed";
  legs: GrantLeg[];
};

/**
 * Outcome of a registry write on the registry chain of a cached network.
 * `via` says how it got there: through that chain's relay, as a direct
 * transaction from the admin key (relay-less registry chains such as
 * Sepolia), or `skipped` when there was nothing to write.
 */
export type RegistryWriteReport = {
  chainId: number;
  via: "relay" | "eoa" | "skipped";
  status: "CONFIRMED" | "FAILED" | "PENDING" | "SKIPPED";
  transactionHash?: Hex;
  /** Block the write landed in; proofs into the cache are anchored at or past it. */
  blockNumber?: bigint;
  /** The L2 whose balance paid for the write, when the relay funded it from there. */
  fundedFromChainId?: number;
  /** The source-chain transaction that locked the funds. */
  sourceTransactionHash?: Hex;
  /** Why the write was skipped or failed, when it was. */
  reason?: string;
};

/** Outcome of proving a registry entry into a cached network's KeyStoreCache. */
export type CacheSyncReport = {
  chainId: number;
  status: "CONFIRMED" | "FAILED" | "SKIPPED";
  keyStoreCache?: Address;
  transactionHash?: Hex;
  /** Registry-chain block the accepted proof was built against. */
  l1BlockNumber?: bigint;
  /** The cache entry after the proof, when one was read. */
  cachedKey?: CachedKey;
  /** Why the proof was skipped or failed, when it was. */
  reason?: string;
};

/** Progress of grantSession. Per-chain phases carry the chain in `detail`. */
export type GrantSessionStatus =
  | "registry-write"
  | "account-authorization"
  | "cache-sync"
  | "done";

/** Progress of revokeSession. Per-chain phases carry the chain in `detail`. */
export type RevokeSessionStatus =
  | "discovery"
  | "registry-write"
  | "account-revoke"
  | "cache-sync"
  | "done";

/** The chain a per-chain progress event is about. */
export type SessionStatusDetail = { chainId: number };

/** Options for grantSession. */
export type GrantSessionOptions = {
  permissions: SessionPermissions;
  /** Unix epoch seconds. Most apps use Date.now()/1000 + N. */
  expiry: number;
  /**
   * Provide your own session signer (e.g., generated by your backend and
   * stored alongside user state). If omitted, the SDK generates a fresh
   * secp256k1 session signer and returns it as part of the Session —
   * but that key exists ONLY in this process's memory. If the process
   * exits before you persist it, the granted on-chain authorization is
   * permanently unusable (revoke-and-regrant is the only exit). Prefer
   * generating your own key, storing it in a secret store, and passing
   * `signerFromPrivateKey(key)` here; persist the rest of the session
   * with `serializeSession`.
   */
  sessionSigner?: Signer;
  /**
   * Register the session's public key in the KeyStore registry (default
   * true). Registration is what lets any third party verify the key's
   * authority on-chain. Pass false for an ephemeral, account-only session —
   * it works identically (permissions/expiry enforced by the account) but is
   * invisible to KeyStore readers such as `verify_authorization`; it can be
   * registered later with `registerSessionKey`.
   */
  register?: boolean;
  /**
   * Cached networks only. After the L1 KeyStore write and the account
   * authorization, prove the new entry into each L2 KeyStoreCache (default
   * true). The proof is a wallet call through the network's relay, paid in the
   * network's native token. Pass false to skip it and call
   * `syncSessionToCache` yourself later.
   */
  populateCache?: boolean;
  /**
   * Progress callback: a registry write per registry chain, an account
   * authorization per network, a cache proof per cached network, then `done`.
   */
  onStatus?: (status: GrantSessionStatus, detail?: SessionStatusDetail) => void;
  /**
   * When `feeToken` is passed to grantSession (one address or a list), each
   * named token gets a daily spend cap in the session's permissions so the
   * session can pay relay fees in it. This is that cap, in the token's smallest
   * unit, applied to each added token; default one whole token per day.
   * Tokens already capped keep their cap.
   */
  feeSpendLimit?: bigint;
};

/**
 * The JSON-safe half of a Session: everything except the secret.
 *
 * `serializeSession` produces this; store it anywhere (a file, a database,
 * localStorage). The session key itself is the caller's to keep — generate
 * it yourself, store it in a secret store, and rebuild the signer at load
 * time. `deserializeSession` marries the two halves back together.
 *
 * `limit` is a decimal string because JSON has no bigint. Unknown extra
 * fields on a stored object are ignored, so callers can wrap this in their
 * own envelope (add names, timestamps, a version field) without friction.
 */
export type SerializedCallPermission =
  | { signature: string; to: Address }
  | { signature: string }
  | { to: Address };

export type SerializedSession = {
  walletAddress: Address;
  publicKey: Hex;
  permissions: {
    calls?: readonly SerializedCallPermission[];
    /** `limit` as a decimal string — JSON has no bigint. */
    spend?: readonly { limit: string; period: SpendPermission["period"]; token?: Address }[];
  };
  expiry: number;
};

/**
 * The safe way to persist a Session: returns a plain JSON-safe object with
 * NO key material in it. Field-by-field on purpose — a GrantSessionResult's
 * transactionHash (and anything else riding on the object) is dropped.
 */
export function serializeSession(session: Session): SerializedSession {
  const { permissions } = session;
  return {
    walletAddress: session.walletAddress,
    publicKey: session.publicKey,
    permissions: {
      ...(permissions.calls ? { calls: permissions.calls.map((c) => ({ ...c })) } : {}),
      ...(permissions.spend
        ? {
            spend: permissions.spend.map((s) => ({
              limit: s.limit.toString(),
              period: s.period,
              ...(s.token ? { token: s.token } : {}),
            })),
          }
        : {}),
    },
    expiry: session.expiry,
  };
}

/**
 * Rebuilds a live Session from its stored half plus the session signer the
 * caller kept (e.g. `signerFromPrivateKey(keyFromYourSecretStore)`).
 *
 * Refuses a signer that does not match the stored `publicKey`: signing with
 * the wrong key would not fail here, it would fail later as an opaque relay
 * rejection. The rebuilt session's `publicKey` is taken from the signer
 * (canonical casing), so a storage layer that re-cased the hex cannot
 * change the on-chain key hash.
 */
export function deserializeSession(stored: SerializedSession, signer: Signer): Session {
  if (signer.publicKey.toLowerCase() !== stored.publicKey.toLowerCase()) {
    throw new Error(
      `deserializeSession: the supplied signer's public key (${signer.publicKey}) does not ` +
        `match the stored session's (${stored.publicKey}). This session was granted to a ` +
        `different key — restore the key that was used at grantSession time.`,
    );
  }
  const spend = stored.permissions.spend?.map((s) => {
    if (!/^\d+$/.test(s.limit)) {
      throw new Error(
        `deserializeSession: permissions.spend limit ${JSON.stringify(s.limit)} is not a ` +
          `decimal string. Limits are serialized as decimal strings (bigint.toString()).`,
      );
    }
    return { limit: BigInt(s.limit), period: s.period, ...(s.token ? { token: s.token } : {}) };
  });
  return {
    walletAddress: stored.walletAddress,
    signer,
    publicKey: signer.publicKey,
    permissions: {
      ...(stored.permissions.calls ? { calls: stored.permissions.calls.map((c) => ({ ...c })) } : {}),
      ...(spend ? { spend } : {}),
    },
    expiry: stored.expiry,
  };
}
