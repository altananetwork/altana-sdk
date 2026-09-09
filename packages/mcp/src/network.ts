/**
 * Chain selection for the MCP server.
 *
 * One server process serves one chain, picked at startup through the
 * ALTANA_CHAIN env var. Every chain listed here executes through an Altana
 * relay (mainnet relay for mainnets, testnet relay for bnb-testnet and
 * celo-sepolia). Sepolia and Base Sepolia are keystore-only (no relay) and
 * are therefore not selectable.
 *
 * Celo and Celo Sepolia are cached-registry networks: their KeyStore lives
 * on Ethereum / Sepolia and is mirrored into a KeyStoreCache on the Celo
 * chain. Registry reads for those go to the registry chain (see
 * registryNetwork); the cache is reported alongside.
 */
import {
  BNB,
  BNB_TESTNET,
  CELO,
  CELO_SEPOLIA,
  ETHEREUM,
  faucetHint,
  isCachedRegistry,
  KEYSTORE_CACHE_NOT_DEPLOYED,
  registryNetwork,
  type NetworkConfig,
} from "@altananetwork/sdk";

export const NETWORKS: Readonly<Record<string, NetworkConfig>> = {
  bnb: BNB,
  "56": BNB,
  ethereum: ETHEREUM,
  "1": ETHEREUM,
  "bnb-testnet": BNB_TESTNET,
  "bsc-testnet": BNB_TESTNET,
  "97": BNB_TESTNET,
  celo: CELO,
  "42220": CELO,
  "celo-sepolia": CELO_SEPOLIA,
  "11142220": CELO_SEPOLIA,
};

/** The names to advertise in errors and docs, in the order users meet them. */
export const SUPPORTED_CHAINS = "bnb (default), ethereum, bnb-testnet, celo, celo-sepolia";

export type ResolvedNetwork = {
  network: NetworkConfig;
  /** The chain whose KeyStore holds this network's registry. Same as `network` on local-registry chains. */
  registry: NetworkConfig;
  /** The lower-cased value that was asked for. */
  requested: string;
  /** False when `requested` was unknown and the default (BNB) was used instead. */
  recognized: boolean;
};

/** Resolve ALTANA_CHAIN (name or chainId, case-insensitive) to a network. Unknown values fall back to BNB. */
export function resolveNetwork(raw: string | undefined): ResolvedNetwork {
  const requested = (raw || "bnb").toLowerCase();
  const network = NETWORKS[requested];
  if (!network) {
    return { network: BNB, registry: BNB, requested, recognized: false };
  }
  return { network, registry: registryNetwork(network), requested, recognized: true };
}

/** One-line description for the startup log: the chain, and the registry chain when it differs. */
export function describeNetwork(network: NetworkConfig): string {
  const base = `${network.chain.name} (chainId ${network.chainId})`;
  if (!isCachedRegistry(network)) return base;
  const registry = network.registry.l1;
  const cache =
    network.registry.keyStoreCache.toLowerCase() === KEYSTORE_CACHE_NOT_DEPLOYED
      ? "cache not deployed yet"
      : `cache ${network.registry.keyStoreCache}`;
  return `${base}; KeyStore registry on ${registry.chain.name} (chainId ${registry.chainId}); ${cache}`;
}

/**
 * Funding guidance for a freshly created wallet on this network: the
 * network's faucet when it has one, and for a cached network whose registry
 * chain has no relay, the registry chain too (registry writes are direct
 * transactions from the wallet's key there).
 */
export function fundingSteps(network: NetworkConfig, address: string): string[] {
  const steps: string[] = [];
  const symbol = network.chain.nativeCurrency.symbol;
  const faucet = faucetHint(network.chainId);
  steps.push(
    `Send some ${symbol} to ${address} on ${network.chain.name}` +
      (faucet ? ` (faucet: ${faucet})` : "") +
      `. Your smart agentic wallet will be activated automatically when you make your first transaction.`,
  );
  if (isCachedRegistry(network) && !network.registry.l1.relayUrl) {
    const registry = network.registry.l1;
    const registrySymbol = registry.chain.nativeCurrency.symbol;
    const registryFaucet = faucetHint(registry.chainId);
    steps.push(
      `This network keeps its KeyStore registry on ${registry.chain.name}, which has no relay: ` +
        `grant_session and revoke_session send the registry write directly from this wallet's ` +
        `key there. Also send a little ${registrySymbol} (about 0.01) to ${address} on ` +
        `${registry.chain.name}` +
        (registryFaucet ? ` (faucet: ${registryFaucet})` : "") +
        `.`,
    );
  }
  return steps;
}
