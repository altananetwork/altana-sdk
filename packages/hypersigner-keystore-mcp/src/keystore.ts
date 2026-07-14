/**
 * KeyStore core: ABIs, chain config, encode helpers, and read helpers.
 *
 * This is the single source of truth reused by the MCP server (./index.ts),
 * the demo gating endpoint, the demo runner, and every test. It is
 * SDK-independent (no @altananetwork/* dependency) — only viem.
 *
 * The KeyStore is a NON-custodial authorization registry. It stores which
 * keys are authorized for an account and their liveness (revoked / expired).
 * It does NOT store spend limits or scope — `isValidKey` answers
 * "exists AND not revoked AND not expired", nothing more.
 */
import {
  type Address,
  type Chain,
  type Hex,
  encodeFunctionData,
  keccak256,
} from "viem";
import { bsc, bscTestnet, mainnet } from "viem/chains";

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

/** KeyStore.sol — reads we use + the revoke write (revoke targets the KeyStore directly). */
export const KEYSTORE_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "getKeys",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "isValidKey",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "getKey",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "validator", type: "address" },
          { name: "publicKey", type: "bytes" },
          { name: "metadata", type: "bytes" },
          { name: "nonce", type: "uint64" },
          { name: "lastUpdated", type: "uint64" },
          { name: "revoked", type: "bool" },
          { name: "expiry", type: "uint40" },
          { name: "isRoot", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "revokeKey",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/** KeyStoreController.sol — the fee read + the two payable register entrypoints. */
export const CONTROLLER_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "getRegistrationFeeInWei",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "registrationFeeUSD",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "treasury",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    stateMutability: "payable",
    name: "initialRegisterKey",
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
    type: "function",
    stateMutability: "payable",
    name: "registerKey",
    inputs: [
      { name: "keyId", type: "bytes32" },
      { name: "validator", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "publicKey", type: "bytes" },
      { name: "expiry", type: "uint40" },
    ],
    outputs: [],
  },
] as const;

export type ChainConfig = {
  key: string;
  chainId: number;
  chain: Chain;
  keyStore: Address;
  controller: Address;
  rpcUrl: string;
  explorerUrl: string;
  currencySymbol: string;
};

export const CHAINS: Record<string, ChainConfig> = {
  bnb: {
    key: "bnb",
    chainId: 56,
    chain: bsc,
    keyStore: "0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a",
    controller: "0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555",
    rpcUrl: "https://bsc-rpc.publicnode.com",
    explorerUrl: "https://bscscan.com",
    currencySymbol: "BNB",
  },
  ethereum: {
    key: "ethereum",
    chainId: 1,
    chain: mainnet,
    keyStore: "0xb70fDa90C1d576Ba8399946a0c10ECD9d9Ea923b",
    controller: "0x30a188Eecf14F4142B0d828ce838C9E1134e7FaA",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://etherscan.io",
    currencySymbol: "ETH",
  },
  // BNB testnet keystore (v1.0.1). This MCP calls the KeyStore/Controller
  // directly (no relay).
  "bnb-testnet": {
    key: "bnb-testnet",
    chainId: 97,
    chain: bscTestnet,
    keyStore: "0x6b8361C29d05D498b1a12B54A37310f94171E94A",
    controller: "0xb530D1971f5453F3359518343F05D0AedFfF7e12",
    rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    explorerUrl: "https://testnet.bscscan.com",
    currencySymbol: "tBNB",
  },
};

const ALIASES: Record<string, string> = {
  bsc: "bnb",
  "56": "bnb",
  eth: "ethereum",
  mainnet: "ethereum",
  "1": "ethereum",
  "bsc-testnet": "bnb-testnet",
  tbnb: "bnb-testnet",
  "97": "bnb-testnet",
};

export function resolveChain(name?: string): ChainConfig {
  const k = (name ?? "bnb").toLowerCase();
  return CHAINS[k] ?? CHAINS[ALIASES[k] ?? ""] ?? CHAINS["bnb"];
}

/** v0 convention: keyId = keccak256(SEC1-uncompressed publicKey bytes). */
export function deriveKeyId(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

export type Call = {
  to: Address;
  value: bigint;
  data: Hex;
  chainId: number;
};

/**
 * Encode a register call (NOT signed). The host/owner signs and sends it; the
 * Controller records the key under msg.sender, so whoever sends this becomes
 * the on-chain `user`. Root keys (the account's first key) must use role="root"
 * with expiry 0; additional/session keys use role="session".
 */
export function buildRegisterCall(args: {
  chain: ChainConfig;
  publicKey: Hex;
  fee: bigint;
  role: "root" | "session";
  expiry?: number;
  validator?: Address;
  metadata?: Hex;
}): Call {
  const expiry = args.role === "root" ? 0 : args.expiry ?? 0;
  const fn = args.role === "root" ? "initialRegisterKey" : "registerKey";
  const data = encodeFunctionData({
    abi: CONTROLLER_ABI,
    functionName: fn,
    args: [
      deriveKeyId(args.publicKey),
      args.validator ?? ZERO_ADDRESS,
      args.metadata ?? "0x",
      args.publicKey,
      expiry,
    ],
  });
  return {
    to: args.chain.controller,
    value: args.fee,
    data,
    chainId: args.chain.chainId,
  };
}

/** Encode a revoke call (NOT signed). msg.sender must equal `user`. value 0, targets the KeyStore. */
export function buildRevokeCall(args: {
  chain: ChainConfig;
  user: Address;
  keyId: Hex;
}): Call {
  const data = encodeFunctionData({
    abi: KEYSTORE_ABI,
    functionName: "revokeKey",
    args: [args.user, args.keyId],
  });
  return {
    to: args.chain.keyStore,
    value: 0n,
    data,
    chainId: args.chain.chainId,
  };
}

/** Minimal client surface so tests can inject a fake without a real RPC. */
export interface Reader {
  readContract(args: unknown): Promise<unknown>;
}

export function readIsValidKey(
  client: Reader,
  chain: ChainConfig,
  user: Address,
  keyId: Hex,
): Promise<boolean> {
  return client.readContract({
    address: chain.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [user, keyId],
  }) as Promise<boolean>;
}

export function readActiveKeys(
  client: Reader,
  chain: ChainConfig,
  user: Address,
): Promise<readonly Hex[]> {
  return client.readContract({
    address: chain.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "getKeys",
    args: [user],
  }) as Promise<readonly Hex[]>;
}

export type KeyRecord = {
  validator: Address;
  publicKey: Hex;
  metadata: Hex;
  nonce: bigint;
  lastUpdated: bigint;
  revoked: boolean;
  expiry: number;
  isRoot: boolean;
};

export function readKey(
  client: Reader,
  chain: ChainConfig,
  user: Address,
  keyId: Hex,
): Promise<KeyRecord> {
  return client.readContract({
    address: chain.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "getKey",
    args: [user, keyId],
  }) as Promise<KeyRecord>;
}

export function readRegistrationFee(
  client: Reader,
  chain: ChainConfig,
): Promise<bigint> {
  return client.readContract({
    address: chain.controller,
    abi: CONTROLLER_ABI,
    functionName: "getRegistrationFeeInWei",
  }) as Promise<bigint>;
}
