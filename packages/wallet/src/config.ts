import {
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  mainnet,
  sepolia,
} from "viem/chains";
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
  /**
   * L1 KeyStore registry. Optional because an L2 can be executable without
   * hosting a registry of its own — Base Sepolia executes session keys whose
   * canonical record lives on Sepolia. Registration and revocation helpers
   * throw a clear error when called on a network without one.
   */
  keyStore?: Address;
  keyStoreController?: Address;
  /** Public RPC URL for reads. Override per-environment if needed. */
  publicRpcUrl: string;
  /** Block explorer base URL. */
  explorer: string;
  /**
   * Altana relay endpoint. Unset for keystore-only networks — no relay serves
   * them, and any attempt to execute through them throws (see buildRelayClient).
   */
  relayUrl?: string;
};

/** Altana relay serving all mainnets. */
export const RELAY_URL = "https://relay.altana.network";

/**
 * Altana testnet relay. Serves BSC testnet (chainId 97) only — the standalone
 * testnet account stack.
 */
export const TESTNET_RELAY_URL = "https://testnet-relay.altana.network";

/**
 * Porto's public relay. Serves Sepolia and Base Sepolia, which Altana's own
 * relay does not. Used for the L1-canonical session-key testnet, where the
 * registry lives on Sepolia and execution happens on Base Sepolia.
 *
 * Note this means the account implementation is Porto's deployment rather than
 * Altana's. Same codebase; verified to expose setCallChecker, canExecute,
 * authorize and setCanExecute on both chains.
 */
export const PORTO_RELAY_URL = "https://rpc.porto.sh";

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
 * BNB Smart Chain Testnet — the full-stack Altana testnet. Standalone
 * ecosystem (no L1Block predeploy, so no L2 cache): keystore + account stack +
 * relay all live on chain 97. Fund wallets from https://testnet.bnbchain.org/faucet-smart.
 *
 * Addresses sourced from the Altana KeyStore deployment manifest:
 *   <altana-keystore>/deployments/bnb-testnet.json (v1.0.1)
 */
export const BNB_TESTNET: NetworkConfig = {
  chain: bscTestnet,
  chainId: 97,
  keyStore: "0x6b8361C29d05D498b1a12B54A37310f94171E94A",
  keyStoreController: "0xb530D1971f5453F3359518343F05D0AedFfF7e12",
  publicRpcUrl: "https://bsc-testnet-rpc.publicnode.com",
  explorer: "https://testnet.bscscan.com",
  relayUrl: TESTNET_RELAY_URL,
};

/**
 * L2 cache deployment for cross-chain session-key verification.
 *
 * Addresses sourced from the Altana KeyStore deployment manifest:
 *   <altana-keystore>/deployments/base.json
 */
export type L2CacheConfig = NetworkConfig & {
  keyStoreCache: Address;
  /**
   * KeyStoreCacheGate — the ICallChecker that makes L1 revocation authoritative
   * for session keys on this chain. Unset where the gate is not yet deployed.
   */
  keyStoreCacheGate?: Address;
  /** The L1 network whose KeyStore this cache mirrors. */
  l1ChainId?: number;
  publicRpcUrl: string;
  explorer: string;
  /**
   * Relay endpoint for EXECUTING on this L2. The cache alone only answers reads;
   * running a session key here needs a relay that serves this chain.
   */
  relayUrl?: string;
};

export const BASE: L2CacheConfig = {
  chain: base,
  chainId: 8453,
  keyStoreCache: "0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a",
  l1ChainId: 1,
  publicRpcUrl: "https://base-rpc.publicnode.com",
  explorer: "https://basescan.org",
};

/**
 * Ethereum Sepolia — the L1 registry for the cross-chain session-key testnet.
 *
 * Reused rather than deployed by Altana tooling. Recorded in
 *   <altana-keystore>/deployments/sepolia.json
 *
 * Note two Sepolia KeyStores have existed; this is the one the explorer indexes
 * and the one the Base Sepolia caches anchor.
 */
export const SEPOLIA: NetworkConfig = {
  chain: sepolia,
  chainId: 11155111,
  keyStore: "0x38Aaf396F462Ad3a4F38ADa653AF6bDEA55F772d",
  keyStoreController: "0xc1525B766c134f7EB5B1d8e4a69C6Cb97Aff2379",
  publicRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  relayUrl: PORTO_RELAY_URL,
};

/**
 * Base Sepolia — the L2 where session keys execute under L1-canonical authority.
 *
 * Addresses from <altana-keystore>/deployments/base-sepolia.json.
 *
 * IMPORTANT: an earlier cache at 0x30b34f10F0a271dAFe6a0A900bCB2Cb94927e39d is
 * still deployed and still reachable, but it predates the RLP storage-leaf decode
 * fix and therefore never enforces session-key expiry. Do not point anything at
 * it. The cache below reports VERSION 1.1.1; a cache reporting 1.1.0 is affected.
 */
export const BASE_SEPOLIA: L2CacheConfig = {
  chain: baseSepolia,
  chainId: 84532,
  keyStoreCache: "0x37ebf8F17c3705568a03fB3A1629AcE7B3D95FFf",
  keyStoreCacheGate: "0x4A85DfdffA461A72F5625A6a7FBB764da2e7d1c7",
  l1ChainId: 11155111,
  publicRpcUrl: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org",
  relayUrl: PORTO_RELAY_URL,
};

/**
 * Returns the network's KeyStore address, or throws with a clear explanation.
 *
 * `keyStore` is optional on NetworkConfig because an L2 can be executable
 * without hosting a registry of its own — Base Sepolia runs session keys whose
 * canonical record lives on Sepolia. Use this wherever a KeyStore is genuinely
 * required, so the failure names the problem instead of surfacing as an
 * `undefined` address in a contract call.
 */
export function keyStoreOf(network: NetworkConfig): Address {
  if (!network.keyStore) {
    throw new Error(
      `Chain ${network.chainId} (${network.chain.name}) has no KeyStore registry. ` +
        `Read and write key records on the L1 network this chain mirrors.`,
    );
  }
  return network.keyStore;
}
