import {
  BASE_SEPOLIA,
  CELO_SEPOLIA,
  SEPOLIA,
  TESTNET_RELAY_URL,
  type NetworkConfig,
} from "@altananetwork/sdk";
import type { Address } from "viem";

export const DEFAULT_CHAIN_ID = CELO_SEPOLIA.chainId;

export type Env = Record<string, string | undefined>;

/** Applies VITE_RELAY_URL and VITE_RPC_<chainId> overrides to a network config. */
export function applyEnv(network: NetworkConfig, env: Env): NetworkConfig {
  const relayUrl = env.VITE_RELAY_URL?.trim();
  const publicRpcUrl = env[`VITE_RPC_${network.chainId}`]?.trim();
  return {
    ...network,
    ...(relayUrl && network.relayUrl ? { relayUrl } : {}),
    ...(publicRpcUrl ? { publicRpcUrl } : {}),
  };
}

export function chainsFromEnv(env: Env): NetworkConfig[] {
  return [CELO_SEPOLIA, BASE_SEPOLIA, SEPOLIA].map((n) => applyEnv(n, env));
}

export function chainName(chainId: number, chains: readonly NetworkConfig[]): string {
  return chains.find((c) => c.chainId === chainId)?.chain.name ?? `chain ${chainId}`;
}

export function nativeSymbol(chainId: number, chains: readonly NetworkConfig[]): string {
  return chains.find((c) => c.chainId === chainId)?.chain.nativeCurrency.symbol ?? "native";
}

export { TESTNET_RELAY_URL };

export type StablecoinInfo = {
  symbol: string;
  address: Address;
  decimals: number;
  source: string;
  sourceUrl?: string;
};

/** Fee tokens the testnet relay accepts on Celo Sepolia (relay.testnet.yaml). */
export const STABLECOINS: Record<number, readonly StablecoinInfo[]> = {
  [CELO_SEPOLIA.chainId]: [
    {
      symbol: "USDC",
      address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
      decimals: 6,
      source: "Circle faucet",
      sourceUrl: "https://faucet.circle.com",
    },
    {
      symbol: "USD₮",
      address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
      decimals: 6,
      source: "Owner-minted only; not fundable on testnet",
    },
    {
      symbol: "USDm",
      address: "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b",
      decimals: 18,
      source: "Mento app",
      sourceUrl: "https://app.mento.org",
    },
    {
      symbol: "EURm",
      address: "0xA99dC247d6b7B2E3ab48a1fEE101b83cD6aCd82a",
      decimals: 18,
      source: "Mento app",
      sourceUrl: "https://app.mento.org",
    },
    {
      symbol: "KESm",
      address: "0xC7e4635651E3e3Af82b61d3E23c159438daE3BbF",
      decimals: 18,
      source: "Mento app",
      sourceUrl: "https://app.mento.org",
    },
  ],
};

export const NATIVE_FAUCETS: Record<number, string> = {
  [CELO_SEPOLIA.chainId]: "https://faucet.celo.org/celo-sepolia",
  [BASE_SEPOLIA.chainId]: "https://www.alchemy.com/faucets/base-sepolia",
  [SEPOLIA.chainId]: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia",
};
