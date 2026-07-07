/**
 * Signer abstraction.
 *
 * A Signer is everything @altananetwork/sdk needs to operate a wallet's main
 * (admin) authority: an address, a public key, and the ability to produce
 * signatures over arbitrary 32-byte digests.
 *
 * In v0 we ship three implementations:
 *   - signerFromPrivateKey   — BYO ECDSA key (or use createPrivateKeySigner
 *                              to generate one). Server-side or CLI use.
 *   - signerFromInjected     — MetaMask / Rabby / any EIP-1193 provider.
 *                              Browser use, "Connect Wallet" flow.
 *   - createPasskey + signerFromPasskey — WebAuthn / P256 in the user's
 *                              device. Browser use, passwordless flow.
 *
 * The Signer interface is intentionally tiny: address, publicKey, signDigest.
 * Anything else (EIP-7702 specifics, passkey ceremony) lives inside the
 * adapter that constructs the Signer.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export type SignerType = "privateKey" | "injected" | "passkey";

/**
 * The signer all SDK functions accept.
 *
 * - `address`     — for EOA-backed signers (privateKey, injected), the
 *                   address that holds the key. For passkey signers, there's
 *                   no on-chain identity tied to the key itself — the wallet
 *                   address comes from createWallet (the upgraded throwaway
 *                   EOA) and the signer's `address` is the zero address.
 * - `publicKey`   — SEC1 uncompressed for secp256k1 (0x04 || x || y).
 *                   For P256/passkey signers, the encoded P256 public key.
 * - `type`        — discriminator; some Porto flows (e.g. registering the
 *                   signer as a Key) need to know the curve.
 * - `signDigest`  — produces a signature over a 32-byte hash. Used for the
 *                   secp256k1 paths (EIP-7702 setCode authorization, etc).
 *                   Passkey signers route through Porto's Key.sign instead
 *                   and throw if this is called directly.
 */
export type Signer = {
  type: SignerType;
  address: Address;
  publicKey: Hex;
  signDigest(digest: Hex): Promise<Hex>;
};

/**
 * Internal-only extension of Signer for signers that hold a raw secp256k1
 * private key. EIP-7702 setCode requires a secp256k1 signature on a specific
 * RLP-encoded payload; that path needs the raw key. Passkey signers cannot
 * satisfy this (P256 != secp256k1) — they go through a throwaway-EOA
 * bootstrap during createWallet instead.
 *
 * Not exported from the public API.
 */
export type PrivateKeySigner = Signer & {
  readonly type: "privateKey";
  readonly _privateKey: Hex;
};

/** Reconstructs a signer from an existing private key. */
export function signerFromPrivateKey(privateKey: Hex): PrivateKeySigner {
  const account = privateKeyToAccount(privateKey);
  return {
    type: "privateKey",
    address: account.address,
    publicKey: account.publicKey,
    _privateKey: privateKey,
    async signDigest(digest: Hex): Promise<Hex> {
      return account.sign({ hash: digest });
    },
  };
}

/** Generates a fresh signer (random secp256k1). Caller persists the key. */
export function createPrivateKeySigner(): PrivateKeySigner {
  const privateKey = generatePrivateKey();
  return signerFromPrivateKey(privateKey);
}

/**
 * Narrowing helper: true if a signer carries an accessible raw private key.
 * Used internally to gate EIP-7702 paths that require the raw key.
 */
export function hasRawPrivateKey(signer: Signer): signer is PrivateKeySigner {
  return signer.type === "privateKey" && "_privateKey" in signer;
}
