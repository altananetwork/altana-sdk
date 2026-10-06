/**
 * Chain selection for the MCP server.
 *
 * One server process serves one chain, picked at startup through the
 * ALTANA_CHAIN env var. Every chain listed here executes through an Altana
 * relay (mainnet relay for mainnets, testnet relay for bnb-testnet and
 * celo-sepolia). Sepolia and Base Sepolia are not in the map below and
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
  NETWORKS as SDK_NETWORKS,
  faucetHint,
  isCachedRegistry,
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

/**
 * Point a network at a local fork.
 *
 * `ALTANA_RPC_URL` and `ALTANA_RELAY_URL` override the chain's endpoints while
 * leaving its contract addresses alone, which forked state already carries. This
 * is what lets an agent flow be proven against an anvil fork, where time can be
 * moved and nothing real is spent, rather than only against live chains.
 *
 * Deliberately not a per-chain setting: the server serves one chain at a time,
 * and a partial override is a configuration nobody can reason about.
 */
export function applyEndpointOverrides(
  network: NetworkConfig,
  env: { rpcUrl?: string; relayUrl?: string } = {
    rpcUrl: process.env.ALTANA_RPC_URL,
    relayUrl: process.env.ALTANA_RELAY_URL,
  },
): NetworkConfig {
  const rpcUrl = env.rpcUrl?.trim();
  const relayUrl = env.relayUrl?.trim();
  if (!rpcUrl && !relayUrl) return network;
  return {
    ...network,
    ...(rpcUrl ? { publicRpcUrl: rpcUrl } : {}),
    ...(relayUrl ? { relayUrl } : {}),
  };
}

/** Resolve ALTANA_CHAIN (name or chainId, case-insensitive) to a network. Unknown values fall back to BNB. */
export function resolveNetwork(raw: string | undefined): ResolvedNetwork {
  const requested = (raw || "bnb").toLowerCase();
  const base = NETWORKS[requested];
  if (!base) {
    const bnb = applyEndpointOverrides(BNB);
    return { network: bnb, registry: bnb, requested, recognized: false };
  }
  const network = applyEndpointOverrides(base);
  // The registry is overridden too when it is the same chain, which it is on
  // chain 97. On a cached network the registry lives elsewhere and is left alone.
  const registry = registryNetwork(base);
  return {
    network,
    registry: registry.chainId === base.chainId ? network : registry,
    requested,
    recognized: true,
  };
}

/**
 * Every execution network in the same environment as `network` (the SDK's
 * mainnet or testnet group). A session revoke acts on all of them: the SDK
 * finds the chains whose account holds the key. A network outside both
 * groups is returned alone.
 */
export function networkGroup(network: NetworkConfig): readonly NetworkConfig[] {
  for (const group of [SDK_NETWORKS.mainnet, SDK_NETWORKS.testnet]) {
    if (group.some((n) => n.chainId === network.chainId)) return group;
  }
  return [network];
}

/** One-line description for the startup log: the chain, and the registry chain when it differs. */
export function describeNetwork(network: NetworkConfig): string {
  const base = `${network.chain.name} (chainId ${network.chainId})`;
  if (!isCachedRegistry(network)) return base;
  const registry = network.registry.l1;
  return `${base}; KeyStore on ${registry.chain.name} (chainId ${registry.chainId}); cache ${network.registry.keyStoreCache}`;
}

/**
 * Funding guidance for a freshly created wallet on this network: the
 * network's faucet when it has one, and for a cached network whose registry
 * chain has no relay, the registry chain too (registry writes are direct
 * transactions from the wallet's key there).
 */
export function fundingSteps(
  network: NetworkConfig,
  address: string,
  opts: {
    /**
     * The fee tokens the network's relay accepts, native first, as
     * `feeCurrencies()` lists them. With more than the native token, the
     * wallet can be funded with any of them instead.
     */
    feeSymbols?: readonly string[];
  } = {},
): string[] {
  const steps: string[] = [];
  const symbol = network.chain.nativeCurrency.symbol;
  const faucet = faucetHint(network.chainId);
  const others = (opts.feeSymbols ?? []).filter((s) => s !== symbol);
  steps.push(
    `Send some ${symbol}` +
      (others.length > 0 ? `, or any of ${others.join(", ")},` : "") +
      ` to ${address} on ${network.chain.name}` +
      (faucet ? ` (faucet: ${faucet})` : "") +
      (others.length > 0
        ? `. The relay takes its fee in whichever of these tokens the wallet holds, so no ${symbol} is needed when it holds one of the others`
        : "") +
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
