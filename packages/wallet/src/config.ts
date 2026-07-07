import { base, bsc, mainnet } from "viem/chains";
import type { Address, Chain } from "viem";

/**
 * Network configuration for @altananetwork/sdk.
 *
 * Addresses sourced from the Altana KeyStore deployment manifests:
 *   <altana-keystore>/deployments/{network}.json
 *
 * If contracts are redeployed, update both that manifest and this file in
 * lockstep.
 */

export type NetworkConfig = {
  chain: Chain;
  chainId: number;
  keyStore: Address;
  keyStoreController: Address;
  /** Public RPC URL for reads. Override per-environment if needed. */
  publicRpcUrl: string;
  /** Block explorer base URL. */
  explorer: string;
  /** Altana relay endpoint. */
  relayUrl: string;
};

/** Altana relay serving all mainnets. */
export const RELAY_URL = "https://relay.altana.network";

export const ETHEREUM: NetworkConfig = {
  chain: mainnet,
  chainId: 1,
  keyStore: "0xb70fDa90C1d576Ba8399946a0c10ECD9d9Ea923b",
  keyStoreController: "0x30a188Eecf14F4142B0d828ce838C9E1134e7FaA",
  publicRpcUrl: "https://ethereum-rpc.publicnode.com",
  explorer: "https://etherscan.io",
  relayUrl: RELAY_URL,
};

export const BNB: NetworkConfig = {
  chain: bsc,
  chainId: 56,
  keyStore: "0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a",
  keyStoreController: "0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555",
  publicRpcUrl: "https://bsc-rpc.publicnode.com",
  explorer: "https://bscscan.com",
  relayUrl: RELAY_URL,
};

/**
 * L2 cache deployment for cross-chain session-key verification.
 *
 * Addresses sourced from the Altana KeyStore deployment manifest:
 *   <altana-keystore>/deployments/base.json
 */
export type L2CacheConfig = {
  chain: typeof base;
  chainId: number;
  keyStoreCache: Address;
  publicRpcUrl: string;
  explorer: string;
};

export const BASE: L2CacheConfig = {
  chain: base,
  chainId: 8453,
  keyStoreCache: "0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a",
  publicRpcUrl: "https://base-rpc.publicnode.com",
  explorer: "https://basescan.org",
};
