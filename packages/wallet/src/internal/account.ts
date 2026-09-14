/**
 * Reads against the Altana account itself (the smart account every wallet
 * address runs on every chain), and the key identities those reads compare.
 *
 * An account is the same address on every chain but holds its own set of
 * keys on each one. These reads are what tells a multi-chain grant or revoke
 * where a key actually lives.
 */

import {
  BaseError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { computeAccountSecp256k1KeyHash, keyHashForSigner } from "./erc1271.js";
import { keyDescriptorFromSigner, type KeyDescriptor } from "./relay.js";
import type { Session } from "./sessions.js";

const KEY_TUPLE = {
  type: "tuple",
  components: [
    { name: "expiry", type: "uint40" },
    { name: "keyType", type: "uint8" },
    { name: "isSuperAdmin", type: "bool" },
    { name: "publicKey", type: "bytes" },
  ],
} as const;

export const ACCOUNT_KEYS_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "keys", ...KEY_TUPLE, type: "tuple[]" },
      { name: "keyHashes", type: "bytes32[]" },
    ],
  },
  {
    name: "getKey",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ name: "key", ...KEY_TUPLE }],
  },
] as const;

/** A key as the account stores it. keyType: P256=0, WebAuthnP256=1, Secp256k1=2, External=3. */
export type AccountKey = {
  expiry: number;
  keyType: number;
  isSuperAdmin: boolean;
  publicKey: Hex;
};

/** Every key the account holds on this chain, with their key hashes. */
export async function getKeys(
  publicClient: PublicClient,
  wallet: Address,
): Promise<{ keys: readonly AccountKey[]; keyHashes: readonly Hex[] }> {
  const [keys, keyHashes] = (await publicClient.readContract({
    address: wallet,
    abi: ACCOUNT_KEYS_ABI,
    functionName: "getKeys",
    blockTag: "latest",
  })) as readonly [readonly AccountKey[], readonly Hex[]];
  return { keys, keyHashes };
}

/** One key by hash. The account reverts for a hash it does not hold. */
export async function getKey(
  publicClient: PublicClient,
  wallet: Address,
  keyHash: Hex,
): Promise<AccountKey> {
  return (await publicClient.readContract({
    address: wallet,
    abi: ACCOUNT_KEYS_ABI,
    functionName: "getKey",
    args: [keyHash],
    blockTag: "latest",
  })) as AccountKey;
}

/**
 * True when the account on this chain holds `keyHash`. False when it does
 * not, including when the call reverts or the address has no account code
 * on this chain (a wallet never used there). A transport failure (RPC down,
 * timeout) is thrown, not read as "no key": a revoke must not report a chain
 * clean because its RPC was unreachable.
 */
export async function accountHasKey(
  publicClient: PublicClient,
  wallet: Address,
  keyHash: Hex,
): Promise<boolean> {
  try {
    await getKey(publicClient, wallet, keyHash);
    return true;
  } catch (err) {
    if (isTransportError(err)) throw err;
    return false;
  }
}

function isTransportError(err: unknown): boolean {
  const transport = (e: unknown) =>
    e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError;
  if (err instanceof BaseError) return Boolean(err.walk(transport));
  return transport(err);
}

/**
 * The account key hash of a session or a bare public key. A Session carries
 * its signer, so its curve is known (secp256k1 or passkey). A bare hex public
 * key is taken as secp256k1 (SEC1 uncompressed), the only curve an SDK
 * session public key can be without its signer.
 */
export function keyHashForSessionOrKey(sessionOrKey: Session | Hex): Hex {
  if (typeof sessionOrKey === "string") {
    return computeAccountSecp256k1KeyHash(publicKeyToAddress(sessionOrKey));
  }
  return keyHashForSigner(sessionOrKey.signer);
}

/** The KeyStore keyId of a session or a bare public key. */
export function keyIdForSessionOrKey(sessionOrKey: Session | Hex): Hex {
  return keccak256(typeof sessionOrKey === "string" ? sessionOrKey : sessionOrKey.publicKey);
}

/** The descriptor the relay needs to revoke a session or a bare public key. */
export function sessionKeyDescriptor(sessionOrKey: Session | Hex): KeyDescriptor {
  if (typeof sessionOrKey === "string") {
    return { type: "secp256k1", publicKey: sessionOrKey, role: "session" };
  }
  return keyDescriptorFromSigner(sessionOrKey.signer, { role: "session" });
}
