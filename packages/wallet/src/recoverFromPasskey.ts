/**
 * Recover a passkey-backed wallet using on-chain state and the OS keychain.
 *
 * Flow (browser only):
 *   1. Discoverable-credential picker — OS shows the user every passkey
 *      saved on this device for the given rpId; they pick one.
 *   2. Extract the wallet address from the assertion's userHandle, which
 *      was baked in at creation time via createPasskeyWallet.
 *   3. Read getKeys(wallet) + getPublicKey(wallet, keyId) from
 *      KeyStore to retrieve the P256 public key the wallet authorized.
 *   4. Rebuild the PasskeySigner from { credentialId, publicKey, rpId }.
 *
 * Two eth_calls + one biometric prompt.
 */

import { bytesToHex, type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import { buildPublicClient } from "./internal/relay.js";
import { readActiveKeys, readPublicKey } from "./internal/keystore.js";
import {
  signerFromPasskey,
  type PasskeySigner,
} from "./internal/passkey.js";
import type { CreateWalletResult } from "./createWallet.js";

export type RecoverFromPasskeyOptions = {
  /** Relying-Party ID — must match what was used at creation time. */
  rpId?: string;
  /**
   * Chain to read KeyStore from. The wallet address is identical on every
   * chain, so any configured chain returns the same admin key. Resolved by
   * the client from a chainId.
   */
  network: NetworkConfig;
};

export async function recoverFromPasskey(
  opts: RecoverFromPasskeyOptions,
): Promise<CreateWalletResult & { signer: PasskeySigner }> {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new Error(
      "recoverFromPasskey() needs a browser — it triggers the WebAuthn " +
        "discoverable-credential picker, which doesn't exist in Node.",
    );
  }

  const network = opts.network;
  const publicClient = buildPublicClient(network);

  // 1. Discoverable credential picker. `allowCredentials: []` tells the OS
  //    to show all passkeys it has for this rpId — the user picks one, then
  //    Face ID / Touch ID / etc.
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge,
      ...(opts.rpId ? { rpId: opts.rpId } : {}),
      allowCredentials: [],
      userVerification: "preferred",
    },
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("No passkey selected.");
  }

  const assertion = credential.response as AuthenticatorAssertionResponse;
  if (!assertion.userHandle) {
    throw new Error(
      "This passkey doesn't carry a wallet address in its userHandle. " +
        "Use createPasskeyWallet() to create recoverable wallets.",
    );
  }

  // 2. userHandle is the 20-byte wallet address we wrote at creation.
  const userHandleBytes = new Uint8Array(assertion.userHandle);
  if (userHandleBytes.length !== 20) {
    const got = bytesToHex(userHandleBytes);
    throw new Error(
      `Passkey userHandle is ${userHandleBytes.length} bytes (got ${got}), ` +
        `expected 20 (an Ethereum address). This passkey was not created ` +
        `by createPasskeyWallet.`,
    );
  }
  const walletAddress = bytesToHex(userHandleBytes) as Address;

  // 3. Look up the admin key in KeyStore. v0 wallets have a single admin
  //    key registered via initialRegisterKey on the first execute. If
  //    nothing is registered yet, the wallet exists but hasn't completed
  //    its first transaction — recovery via this path needs at least one
  //    on-chain registration to have happened.
  const activeKeys = await readActiveKeys(publicClient, network, walletAddress);
  if (activeKeys.length === 0) {
    throw new Error(
      `Picked passkey resolves to wallet ${walletAddress}, but that wallet ` +
        `has no keys registered in KeyStore yet. Either: (a) you picked the ` +
        `wrong passkey (the OS keychain has multiple with similar names — ` +
        `use unique names per test), or (b) this wallet was created but ` +
        `never executed a transaction, so its admin key isn't on-chain yet.`,
    );
  }
  const keyId = activeKeys[0] as Hex;
  const publicKey = await readPublicKey(publicClient, network, walletAddress, keyId);

  // 4. Rebuild the credential reference. PublicKeyCredential.id is already
  //    a base64url string — exactly what ox.WebAuthnP256.sign expects
  //    (it calls Base64.toBytes on it). Do NOT hex-encode rawId here;
  //    that produces a 0x-prefixed string that ox decodes as garbage,
  //    and the browser then can't find the credential locally and falls
  //    back to hybrid (QR-code-to-another-device) transport.
  const signer = signerFromPasskey({
    kind: "webauthn",
    id: credential.id,
    publicKey,
    ...(opts.rpId ? { rpId: opts.rpId } : {}),
  });

  return {
    address: walletAddress,
    signer,
  };
}
