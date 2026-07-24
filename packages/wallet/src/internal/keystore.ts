/**
 * KeyStore call encoding + read helpers.
 *
 * The KeyStore contract is signature-scheme agnostic: it stores opaque bytes.
 * Convention for v0:
 *   - keyId        = keccak256(publicKey)
 *   - validator    = address(0)  (no on-chain validator for secp256k1 in v0)
 *   - metadata     = "0x"        (none)
 *   - publicKey    = SEC1 uncompressed: 0x04 || x || y (65 bytes, viem default)
 */

import {
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { NetworkConfig } from "../config.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const CONTROLLER_ABI = [
  {
    name: "initialRegisterKey",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "keyId", type: "bytes32" },
      { name: "validator", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "publicKey", type: "bytes" },
      { name: "expiry", type: "uint40" },
    ],
    outputs: [],
  },
  {
    name: "registerKey",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "keyId", type: "bytes32" },
      { name: "validator", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "publicKey", type: "bytes" },
      { name: "expiry", type: "uint40" },
    ],
    outputs: [],
  },
  {
    name: "getRegistrationFeeInWei",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const KEYSTORE_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    name: "getPublicKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bytes" }],
  },
  {
    name: "revokeKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const UINT40_MAX = 2 ** 40 - 1;

function toUint40Expiry(expiry: number | undefined): number {
  if (!expiry || expiry < 0) return 0;
  const v = Math.floor(expiry);
  return v > UINT40_MAX ? UINT40_MAX : v;
}

/** Derives the v0 keyId convention from a SEC1-encoded public key. */
export function deriveKeyId(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

/** Reads the current registration fee from the Controller. */
export function readRegistrationFee(
  publicClient: PublicClient,
  network: NetworkConfig,
): Promise<bigint> {
  return publicClient.readContract({
    address: network.keyStoreController,
    abi: CONTROLLER_ABI,
    functionName: "getRegistrationFeeInWei",
  });
}

/** Reads the active key ids for a user. Empty array = not yet registered. */
export function readActiveKeys(
  publicClient: PublicClient,
  network: NetworkConfig,
  user: Address,
): Promise<readonly Hex[]> {
  return publicClient.readContract({
    address: network.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "getKeys",
    args: [user],
  }) as Promise<readonly Hex[]>;
}

/**
 * Reads the public key bytes stored for (user, keyId). Used by the passkey
 * recovery flow to reconstruct a wallet's admin authority from on-chain
 * state when localStorage is unavailable.
 */
export function readPublicKey(
  publicClient: PublicClient,
  network: NetworkConfig,
  user: Address,
  keyId: Hex,
): Promise<Hex> {
  return publicClient.readContract({
    address: network.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "getPublicKey",
    args: [user, keyId],
  }) as Promise<Hex>;
}

/**
 * Reads whether (user, keyId) is a currently valid KeyStore entry —
 * registered, unexpired, unrevoked. The same check `verify_authorization`
 * uses. revokeSession gates its KeyStore call on this (a never-registered
 * key would revert the whole revoke bundle), and registerSessionKey uses it
 * for idempotency.
 */
export function readIsValidKey(
  publicClient: PublicClient,
  network: NetworkConfig,
  user: Address,
  keyId: Hex,
): Promise<boolean> {
  return publicClient.readContract({
    address: network.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [user, keyId],
  }) as Promise<boolean>;
}

/**
 * Returns the KeyStore initial-register call to prepend to a wallet's first
 * admin-signed action, or an empty array if the wallet is already
 * registered. Use this in every entry point that lets an admin act on the
 * wallet (execute, grantSession, revokeSession) so the admin key always
 * lands in KeyStore on whichever call happens to be first — that's what
 * makes recovery-from-passkey work.
 */
export async function buildFirstActionPrepend(args: {
  publicClient: PublicClient;
  network: NetworkConfig;
  walletAddress: Address;
  adminPublicKey: Hex;
}): Promise<{ to: Address; value: bigint; data: Hex }[]> {
  const active = await readActiveKeys(
    args.publicClient,
    args.network,
    args.walletAddress,
  );
  if (active.length > 0) return [];
  const fee = await readRegistrationFee(args.publicClient, args.network);
  return [
    buildInitialRegisterCall({
      publicKey: args.adminPublicKey,
      fee,
      network: args.network,
    }),
  ];
}

/**
 * Builds the call payload to register a wallet's admin authority in KeyStore
 * for the first time. The caller must supply msg.value >= fee (read via
 * readRegistrationFee). Use this in the first execute() so registration
 * batches with whatever the agent is actually doing.
 *
 * `publicKey` is the SEC1-encoded public key of the admin authority — for
 * privateKey signers, the secp256k1 pubkey; for passkey signers, the P256
 * pubkey. KeyStore is signature-scheme agnostic (stores opaque bytes), so
 * the same call shape works for both.
 */
export function buildInitialRegisterCall(args: {
  publicKey: Hex;
  fee: bigint;
  network: NetworkConfig;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.network.keyStoreController,
    value: args.fee,
    data: encodeFunctionData({
      abi: CONTROLLER_ABI,
      functionName: "initialRegisterKey",
      // Root keys must have expiry=0 (enforced by KeyStore v1.0.0).
      args: [
        deriveKeyId(args.publicKey),
        ZERO_ADDRESS,
        "0x",
        args.publicKey,
        0,
      ],
    }),
  };
}

/**
 * Builds the call to register an ADDITIONAL key (e.g. a freshly granted
 * session key) on a wallet that's already initialRegistered in KeyStore.
 * Pays the same fee as initialRegisterKey. Use inside grantSession so the
 * session shows up in the public KeyStore registry, not just on Porto's
 * smart-account contract.
 */
export function buildAdditionalRegisterCall(args: {
  publicKey: Hex;
  fee: bigint;
  network: NetworkConfig;
  /** Unix-seconds expiry. Pass 0 or omit for a non-expiring session key. */
  expiry?: number;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.network.keyStoreController,
    value: args.fee,
    data: encodeFunctionData({
      abi: CONTROLLER_ABI,
      functionName: "registerKey",
      args: [
        deriveKeyId(args.publicKey),
        ZERO_ADDRESS,
        "0x",
        args.publicKey,
        toUint40Expiry(args.expiry),
      ],
    }),
  };
}

/**
 * Builds the call to revoke a key (e.g. a session being torn down) in
 * KeyStore. Called directly on the KeyStore contract — no fee, no
 * controller in the middle. The wallet itself is the msg.sender (it's
 * executing inside its own userOp), which satisfies KeyStore's
 * onlyKeyOwnerOrValidator modifier. Revocation is monotonic in v1.0.0:
 * once revoked, a key cannot be re-activated.
 */
export function buildRevokeKeyCall(args: {
  walletAddress: Address;
  keyId: Hex;
  network: NetworkConfig;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.network.keyStore,
    value: 0n,
    data: encodeFunctionData({
      abi: KEYSTORE_ABI,
      functionName: "revokeKey",
      args: [args.walletAddress, args.keyId],
    }),
  };
}
