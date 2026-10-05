/**
 * The keys the showcase walks through, loaded rather than typed.
 *
 * A demo that starts with someone pasting 66 hex characters into a field on a
 * projector has its most fragile step first, and a typo there looks exactly
 * like the mirror saying "not valid", which is the one message the showcase
 * exists to make trustworthy. So the keys are registered ahead of time, written
 * to `celo-harness/evidence/showcase-keys.json` by qa, and picked from a list.
 *
 * The file is **fetched at runtime**, like `proof.json`, not imported at build
 * time. It lives outside this repository, so a build-time import would break
 * `apps/testbench` for anyone who clones altana-sdk without the harness beside
 * it, and would need a rebuild every time qa re-proves a key.
 * `scripts/copy-showcase-keys.mjs` puts a copy in `public/`.
 *
 * Only `user` and `publicKey` reach the mirror card. Everything else is
 * provenance for the write-up, and `demoNote` is what the operator reads out.
 */

import { keccak256, isAddress, isHex, type Address, type Hex } from "viem";

export type ShowcaseKey = {
  role: string;
  label: string;
  demoNote?: string;
  user: Address;
  /** The bytes `populateKey` takes. Its presence is what keeps Prove live. */
  publicKey: Hex;
  /** keccak256(publicKey): what the KeyStore and the cache key on. */
  keyStoreKeyId: Hex;
  /** The account's wrapped hash. Provenance only; never query the cache with it. */
  accountKeyHash?: Hex;
  keyType?: number;
  registrationTx?: string;
  registrationL1Block?: number;
  cacheProofTx?: string | null;
  anchoredL1Block?: number | null;
  revocationTx?: string | null;
  revocationCacheProofTx?: string | null;
};

export type ShowcaseFile = {
  updated?: string;
  keys: ShowcaseKey[];
  /** Entries the file carried that could not be trusted, with why. */
  rejected: { role: string; reason: string }[];
};

/**
 * Accepts anything and returns the keys that are safe to put on a screen.
 *
 * The load-bearing check is `keccak256(publicKey) === keyStoreKeyId`. Both
 * fields are generated, and if they ever disagree the card would read the
 * mirror for a different key and report "never registered" in front of an
 * audience, which is indistinguishable from the feature being broken. Better
 * to drop the entry here and say why.
 *
 * Both public key shapes are accepted: 65 bytes for an uncompressed secp256k1
 * key (0x04 ‖ x ‖ y) and 64 for a flat WebAuthn P256 key, which is what the
 * passkey admin key is. The KeyStore hashes the raw bytes either way.
 */
export function parseShowcaseKeys(raw: unknown): ShowcaseFile {
  const empty: ShowcaseFile = { keys: [], rejected: [] };
  if (!raw || typeof raw !== "object") return empty;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.keys)) return empty;

  const keys: ShowcaseKey[] = [];
  const rejected: { role: string; reason: string }[] = [];

  for (const entry of r.keys) {
    if (!entry || typeof entry !== "object") continue;
    const k = entry as Record<string, unknown>;
    const role = typeof k.role === "string" ? k.role : "unnamed";

    if (typeof k.user !== "string" || !isAddress(k.user)) {
      rejected.push({ role, reason: "its wallet is not an address" });
      continue;
    }
    if (typeof k.publicKey !== "string" || !isHex(k.publicKey) || k.publicKey.length < 130) {
      rejected.push({ role, reason: "its public key is missing or too short to be one" });
      continue;
    }
    const derived = keccak256(k.publicKey as Hex);
    if (typeof k.keyStoreKeyId === "string" && k.keyStoreKeyId.toLowerCase() !== derived.toLowerCase()) {
      rejected.push({
        role,
        reason: "its keyStoreKeyId is not keccak256 of its public key, so one of the two is wrong",
      });
      continue;
    }

    keys.push({
      role,
      label: typeof k.label === "string" ? k.label : role,
      ...(typeof k.demoNote === "string" ? { demoNote: k.demoNote } : {}),
      user: k.user as Address,
      publicKey: k.publicKey as Hex,
      keyStoreKeyId: derived,
      ...(typeof k.accountKeyHash === "string" ? { accountKeyHash: k.accountKeyHash as Hex } : {}),
      ...(typeof k.keyType === "number" ? { keyType: k.keyType } : {}),
      ...(typeof k.registrationTx === "string" ? { registrationTx: k.registrationTx } : {}),
      ...(typeof k.registrationL1Block === "number" ? { registrationL1Block: k.registrationL1Block } : {}),
      ...(typeof k.revocationTx === "string" ? { revocationTx: k.revocationTx } : {}),
    });
  }

  return {
    ...(typeof r.updated === "string" ? { updated: r.updated } : {}),
    keys,
    rejected,
  };
}

/** Fetches the copy in `public/`. Never throws; an absent file is not an error. */
export async function loadShowcaseKeys(
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
): Promise<ShowcaseFile | undefined> {
  if (!fetchImpl) return undefined;
  try {
    const res = await fetchImpl("/showcase-keys.json");
    if (!res.ok) return undefined;
    return parseShowcaseKeys(await res.json());
  } catch {
    return undefined;
  }
}

/** A key that was revoked on the registry reads as revoked, not broken. */
export function expectedEndState(key: ShowcaseKey): "revoked" | "live" {
  return key.revocationTx ? "revoked" : "live";
}
