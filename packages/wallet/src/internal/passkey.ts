/**
 * Passkey signer adapter.
 *
 * A passkey signer represents a WebAuthn / P256 key that controls a Altana
 * smart-account wallet. Two variants:
 *
 *  - `webauthn`  (production): the real WebAuthn API. The credential ID +
 *                 public key are persistable across sessions; the private key
 *                 lives inside the user's device (Secure Enclave / TPM) and
 *                 each signature requires a biometric prompt.
 *  - `headless`  (tests / Node): a raw P256 private key, wrapped in Porto's
 *                 WebAuthn signature format. Used by smoke tests and any
 *                 server-side scenario. NOT for production user accounts —
 *                 there's no biometric gate.
 *
 * The passkey itself is P256, but EIP-7702 setCode requires a secp256k1
 * signature from the EOA being upgraded. createWallet handles that with a
 * one-shot throwaway-EOA: it generates a secp256k1 key, uses it to sign the
 * upgrade authorization (with the passkey listed as `authorizeKeys`), then
 * discards the throwaway key. From that point on, the smart-account address
 * is the throwaway EOA's address and the only authority on it is the passkey.
 *
 * Porto natively understands `webauthn-p256` keys — `Key.sign(key, ...)` does
 * the WebAuthn ceremony and wraps the P256 signature in Porto's expected
 * envelope. The relay layer treats passkey signers like any other key.
 */

import * as Key from "porto/viem/Key";
import * as PublicKey from "ox/PublicKey";
import { hexToBytes, type Address, type Hex } from "viem";
import type { Signer } from "./signer.js";

/**
 * Persistable handle for a passkey. JSON-safe — apps can stringify it and
 * drop it in localStorage / a database, then rehydrate via
 * `signerFromPasskey`. No BigInts.
 *
 * `publicKey` is the flat P256 form (x || y, no 0x04 prefix) — the same
 * shape Porto's relay uses on the wire. KeyStore + Porto already accept
 * this; if you need the SEC1-uncompressed form, prepend `0x04` yourself.
 */
export type PasskeyCredential =
  | {
      readonly kind: "webauthn";
      /**
       * WebAuthn credential ID as a base64url string (e.g. `m1-bMPuAqpW…`).
       * This is the format the browser's `PublicKeyCredential.id` returns
       * and the format ox / Porto pass to `Base64.toBytes` internally.
       * NOT 0x-prefixed hex.
       */
      readonly id: string;
      /** Flat P256 public key (x || y), no 0x04 prefix. */
      readonly publicKey: Hex;
      /** Relying Party ID. Defaults to current origin's host in browser. */
      readonly rpId?: string;
    }
  | {
      readonly kind: "headless";
      /** Raw P256 private key. ONLY for tests / server-side scripts. */
      readonly privateKey: Hex;
      /** Flat P256 public key (x || y), no 0x04 prefix. */
      readonly publicKey: Hex;
    };

export type PasskeySigner = Signer & {
  readonly type: "passkey";
  readonly credential: PasskeyCredential;
};

/**
 * Create a fresh passkey by prompting the user via WebAuthn (browser only).
 * Throws in non-browser environments — use `createHeadlessPasskey` for tests.
 *
 * `userId` is the WebAuthn user handle baked into the credential. Whatever
 * you put here, the OS hands back on every future assertion — including
 * discoverable-credential lookups on a fresh device. Pass the wallet's
 * smart-account address so `recoverFromPasskey` can find the wallet from
 * the passkey alone. When this is set, the throwaway-EOA for the EIP-7702
 * upgrade must already exist — see `createPasskeyWallet` for the full
 * sequence.
 */
export async function createPasskey(params: {
  name: string;
  rpId?: string;
  userId?: Hex;
}): Promise<PasskeySigner> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new Error(
      "createPasskey({ name }) needs a browser — it prompts the user for a " +
        "biometric (Face ID / Touch ID / Windows Hello) via WebAuthn, which " +
        "isn't available in Node or other server runtimes.\n" +
        "If you're writing a test or running server-side, use " +
        "createHeadlessPasskey() — same wallet shape, but the P256 key is " +
        "held in memory with no biometric prompt.",
    );
  }
  // Build the Porto WebAuthn key (this triggers the biometric prompt).
  // If userId is provided, the OS stores it inside the credential as the
  // userHandle — returned verbatim on every future assertion. We use this
  // to encode the wallet address so recoverFromPasskey can find the
  // wallet from the credential alone.
  const key = await Key.createWebAuthnP256({
    label: params.name,
    role: "admin",
    rpId: params.rpId,
    ...(params.userId ? { userId: hexToBytes(params.userId) } : {}),
  });

  // Porto stores the credential under key.privateKey = { credential: { id,
  // publicKey: PublicKey }, rpId }, where PublicKey is { x, y, prefix } with
  // BigInt fields. We serialize to SEC1-uncompressed hex (0x04 || x || y) so
  // the credential is plain JSON and can be persisted to localStorage etc.
  const pk: any = (key as any).privateKey;
  if (!pk?.credential?.publicKey) {
    throw new Error("createPasskey: Porto key missing credential.publicKey");
  }
  // Use Porto's flat hex form (no 0x04 prefix) — that's what KeyStore +
  // Porto's RPC layer both speak. We round-trip back to a structured
  // PublicKey when we need to rebuild the Key (see passkeyToPortoKey).
  const publicKeyHex = PublicKey.toHex(pk.credential.publicKey, {
    includePrefix: false,
  }) as Hex;
  return signerFromPasskey({
    kind: "webauthn",
    // pk.credential.id from ox is already the base64url string we want.
    id: pk.credential.id as string,
    publicKey: publicKeyHex,
    ...(params.rpId ? { rpId: params.rpId } : {}),
  });
}

/**
 * Create a passkey backed by a raw P256 key. For tests and server-side use.
 * No biometric prompt; the private key is in memory.
 */
export function createHeadlessPasskey(): PasskeySigner {
  const key = Key.createHeadlessWebAuthnP256({ role: "admin" });
  const pk: any = (key as any).privateKey;
  if (typeof pk?.privateKey !== "function") {
    throw new Error("createHeadlessPasskey: Porto returned unexpected key shape");
  }
  // Porto's key.publicKey is the flat form (x || y, no 0x04 prefix). That's
  // what KeyStore + the Porto RPC layer expect, so we leave it alone.
  return signerFromPasskey({
    kind: "headless",
    privateKey: pk.privateKey() as Hex,
    publicKey: key.publicKey as Hex,
  });
}

/** Rebuild a passkey signer from a persisted credential. */
export function signerFromPasskey(credential: PasskeyCredential): PasskeySigner {
  return {
    type: "passkey",
    // Passkeys aren't EOAs — there's no on-chain address tied to the key
    // itself. The wallet address comes from createWallet (the throwaway EOA
    // that was upgraded). Callers should always use wallet.address, not
    // signer.address, for the wallet itself.
    address: "0x0000000000000000000000000000000000000000" as Address,
    publicKey: credential.publicKey,
    credential,
    async signDigest(_digest: Hex): Promise<Hex> {
      // A passkey signs P256, not secp256k1. The signDigest method on the
      // Signer interface is the secp256k1 path. Wallet operations on a
      // passkey-backed wallet should always go through createWallet /
      // execute / grantSession / revokeSession — those route to Porto's
      // native WebAuthn signing flow. If you're seeing this thrown, you're
      // probably calling signDigest on the signer directly; switch to the
      // SDK's wallet operations instead.
      throw new Error(
        "A passkey can't be used to sign a raw digest directly. " +
          "Use execute(wallet, passkey, calls) (and the other @altananetwork/sdk " +
          "operations) — they handle the WebAuthn ceremony for you.",
      );
    },
  };
}

/** Narrowing helper. */
export function isPasskeySigner(signer: Signer): signer is PasskeySigner {
  return signer.type === "passkey";
}

/**
 * Build the Porto-format Key for a passkey signer with the requested role
 * and (optional) session permissions. The relay layer calls this every time
 * it needs to sign or authorize on behalf of the passkey.
 *
 * For session-key permissions, Porto computes a key hash from
 * (publicKey + role + expiry + permissions); the same descriptor must be
 * used at grant time and at use time so the hashes match.
 */
export function passkeyToPortoKey(
  signer: PasskeySigner,
  opts: {
    role: "admin" | "session";
    expiry?: number;
    permissions?: any;
  },
): any {
  const cred = signer.credential;
  const common = {
    role: opts.role,
    ...(opts.expiry !== undefined ? { expiry: opts.expiry } : {}),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  };
  if (cred.kind === "headless") {
    return Key.fromHeadlessWebAuthnP256({
      privateKey: cred.privateKey,
      ...common,
    } as any);
  }
  // We persist publicKey as the flat form (no prefix). PublicKey.fromHex
  // wants the SEC1 form with 0x04, so prepend before parsing — that gives
  // us the { x, y, prefix } object Porto's Key.fromWebAuthnP256 expects.
  const sec1Hex = (`0x04${cred.publicKey.slice(2)}`) as Hex;
  const publicKeyObject = PublicKey.fromHex(sec1Hex);
  return Key.fromWebAuthnP256({
    credential: { id: cred.id, publicKey: publicKeyObject as any },
    ...(cred.rpId ? { rpId: cred.rpId } : {}),
    ...common,
  } as any);
}
