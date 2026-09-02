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

/**
 * WHEN YOU NEED THIS — the whole rule in two lines:
 *  - In a browser (mobile browsers included): never. Omit it; the SDK
 *    uses the built-in WebAuthn API automatically.
 *  - In a native mobile app (React Native, Expo, Capacitor): always.
 *    There is no built-in WebAuthn there — pass your passkey library's
 *    create/get functions and the SDK uses them everywhere it would have
 *    used the browser's: creation, recovery, and every signature.
 *
 * Details for implementers: types derive from porto's own parameters (not
 * DOM globals) so React Native tsconfigs typecheck; porto requires the
 * assertion response to include `userHandle` — a library that omits it
 * fails with "No user handle in response".
 */
export type PasskeyWebAuthnFns = {
  createFn?: Key.createWebAuthnP256.Parameters["createFn"];
  getFn?: NonNullable<Key.sign.Parameters["webAuthn"]>["getFn"];
};

export type PasskeySigner = Signer & {
  readonly type: "passkey";
  readonly credential: PasskeyCredential;
  /**
   * WebAuthn function overrides carried at runtime. Function-valued, so a
   * JSON round-trip silently drops it — re-attach after rehydration via
   * `signerFromPasskey(credential, { webAuthn })`.
   */
  readonly webAuthn?: PasskeyWebAuthnFns;
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
  /** Browser: omit. Native mobile app (React Native etc.): required — see PasskeyWebAuthnFns. */
  webAuthn?: PasskeyWebAuthnFns;
}): Promise<PasskeySigner> {
  if (!params.webAuthn?.createFn && (typeof navigator === "undefined" || !navigator.credentials)) {
    throw new Error(
      "createPasskey({ name }) needs the WebAuthn API — it prompts the user " +
        "for a biometric (Face ID / Touch ID / Windows Hello), which isn't " +
        "available in Node, React Native, or other runtimes without a browser.\n" +
        "Options: in React Native and similar, supply the native passkey " +
        "library's functions via webAuthn: { createFn, getFn }. For tests or " +
        "server-side code, use createHeadlessPasskey() — same wallet shape, " +
        "but the P256 key is held in memory with no biometric prompt.",
    );
  }
  // Outside a browser, ox falls back to window.location.hostname /
  // window.document.title for the relying party — a hard crash mid-flow.
  // Require an explicit rpId so the failure is immediate and clear. The
  // rpId is also persisted on the credential and needed at every later
  // signature, so it must be stable.
  if (params.webAuthn?.createFn && typeof window === "undefined" && !params.rpId) {
    throw new Error(
      "createPasskey: rpId is required when supplying webAuthn.createFn " +
        "outside a browser — there is no window.location to default it from. " +
        "Use your app's associated domain (the same value your native passkey " +
        "library is configured with).",
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
    ...(params.webAuthn?.createFn ? { createFn: params.webAuthn.createFn } : {}),
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
  return signerFromPasskey(
    {
      kind: "webauthn",
      // pk.credential.id from ox is already the base64url string we want.
      id: pk.credential.id as string,
      publicKey: publicKeyHex,
      ...(params.rpId ? { rpId: params.rpId } : {}),
    },
    params.webAuthn ? { webAuthn: params.webAuthn } : undefined,
  );
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

/**
 * Rebuild a passkey signer from a persisted credential. In runtimes without
 * the browser WebAuthn API, re-attach the native passkey library's functions
 * via `opts.webAuthn` — they are function-valued and never survive
 * persistence.
 */
export function signerFromPasskey(
  credential: PasskeyCredential,
  opts?: { webAuthn?: PasskeyWebAuthnFns },
): PasskeySigner {
  return {
    type: "passkey",
    ...(opts?.webAuthn ? { webAuthn: opts.webAuthn } : {}),
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
