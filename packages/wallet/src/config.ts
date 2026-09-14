import { base, bsc, bscTestnet, celo, celoSepolia, mainnet, sepolia } from "viem/chains";
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

/**
 * Where a network's KeyStore registry lives.
 *
 * - `local`: the KeyStore and Controller are deployed on the network itself
 *   (BNB, Ethereum, BNB testnet). Registry writes batch into the same relay
 *   intent as the wallet's own calls. This is the default when `registry` is
 *   omitted from a NetworkConfig.
 * - `cached`: the network has no KeyStore of its own. Authority is rooted in
 *   the registry of another chain (`l1`) and proven into a KeyStoreCache
 *   contract deployed on this network (`keyStoreCache`). Registry writes go
 *   to `l1`; decisions are read from `l1`; the cache is the proof target and
 *   the read surface for third parties on this chain. Celo (mainnet and
 *   Sepolia) uses this shape.
 */
export type KeyStoreRegistry =
  | { kind: "local" }
  | { kind: "cached"; l1: NetworkConfig; keyStoreCache: Address };

export type NetworkConfig = {
  chain: Chain;
  chainId: number;
  /**
   * KeyStore address. On a `cached` network this is the registry chain's
   * KeyStore (the contract lives on `registry.l1`, not on this chain), kept
   * here so readers that only know one config still find the registry.
   */
  keyStore: Address;
  /** KeyStoreController address. Same placement rule as `keyStore`. */
  keyStoreController: Address;
  /** Public RPC URL for reads. Override per-environment if needed. */
  publicRpcUrl: string;
  /** Block explorer base URL. */
  explorer: string;
  /**
   * Altana relay endpoint. Unset for keystore-only networks: no relay serves
   * them, and any attempt to execute through them throws (see buildRelayClient).
   */
  relayUrl?: string;
  /**
   * Registry topology. Omitted means `{ kind: "local" }`. See KeyStoreRegistry.
   */
  registry?: KeyStoreRegistry;
};

/** Altana relay serving all mainnets. */
export const RELAY_URL = "https://relay.altana.network";

/**
 * Altana testnet relay. Serves BSC testnet (chainId 97) and Celo Sepolia
 * (chainId 11142220). Sepolia and Base Sepolia are keystore-only testnets and
 * have no relay.
 */
export const TESTNET_RELAY_URL = "https://testnet-relay.altana.network";

/**
 * Placeholder for a `registry.keyStoreCache` that has not been filled in.
 * `keyStoreCacheOf` refuses it, so no proof is ever sent to the zero address.
 */
export const KEYSTORE_CACHE_UNSET: Address =
  "0x0000000000000000000000000000000000000000";

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
 * BNB Smart Chain Testnet, the full-stack Altana testnet. Standalone
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
 * Sepolia: hosts the testnet KeyStore behind Celo Sepolia. No Altana relay
 * serves it; KeyStore writes are sent as direct transactions from the
 * wallet's admin key, funded with Sepolia ETH:
 * https://cloud.google.com/application/web3/faucet/ethereum/sepolia
 *
 * The public RPC must serve `eth_getProof` for the block Celo Sepolia
 * anchors, which runs about 100 blocks behind head; 0xrpc.io keeps a
 * 128-block proof window.
 *
 * Addresses sourced from the Altana KeyStore deployment manifest:
 *   <altana-keystore>/deployments/sepolia.json
 */
export const SEPOLIA: NetworkConfig = {
  chain: sepolia,
  chainId: 11155111,
  keyStore: "0x38Aaf396F462Ad3a4F38ADa653AF6bDEA55F772d",
  keyStoreController: "0xc1525B766c134f7EB5B1d8e4a69C6Cb97Aff2379",
  publicRpcUrl: "https://0xrpc.io/sep",
  explorer: "https://sepolia.etherscan.io",
};

/**
 * Celo Sepolia (chain 11142220). Wallets run through the Altana testnet
 * relay with fees in CELO; session keys are registered in the Sepolia
 * KeyStore and proven into the KeyStoreCacheOPStack contract on Celo Sepolia
 * through the OP-stack `L1Block` predeploy. Fund wallets from
 * https://faucet.celo.org/celo-sepolia.
 *
 * Addresses sourced from the Altana KeyStore deployment manifest:
 *   <altana-keystore>/deployments/celo-sepolia.json
 */
export const CELO_SEPOLIA: NetworkConfig = {
  chain: celoSepolia,
  chainId: 11142220,
  keyStore: SEPOLIA.keyStore,
  keyStoreController: SEPOLIA.keyStoreController,
  publicRpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
  explorer: "https://sepolia.celoscan.io",
  relayUrl: TESTNET_RELAY_URL,
  registry: {
    kind: "cached",
    l1: SEPOLIA,
    // KeyStoreCacheOPStack 1.1.1, deployed 2026-09-09 (deploy block 35678512).
    // Source: <altana-keystore>/deployments/celo-sepolia.json.
    keyStoreCache: "0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD",
  },
};

/**
 * Celo (chain 42220). Wallets run through the Altana relay with fees in
 * CELO; session keys are registered in the Ethereum KeyStore and proven into
 * the KeyStoreCache on Celo.
 *
 * `keyStoreCache`: fill in from <altana-keystore>/deployments/celo.json.
 */
export const CELO: NetworkConfig = {
  chain: celo,
  chainId: 42220,
  keyStore: ETHEREUM.keyStore,
  keyStoreController: ETHEREUM.keyStoreController,
  publicRpcUrl: "https://celo-rpc.publicnode.com",
  explorer: "https://celoscan.io",
  relayUrl: RELAY_URL,
  registry: {
    kind: "cached",
    l1: ETHEREUM,
    keyStoreCache: KEYSTORE_CACHE_UNSET,
  },
};

/**
 * The network whose KeyStore holds this network's registry: the network
 * itself for a local registry, `registry.l1` for a cached one. Every registry
 * read and write in the SDK goes through this.
 */
export function registryNetwork(network: NetworkConfig): NetworkConfig {
  return network.registry?.kind === "cached" ? network.registry.l1 : network;
}

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
