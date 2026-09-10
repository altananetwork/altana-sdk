/**
 * Network configs: the Celo Sepolia / Celo cached-registry shape, the Sepolia
 * registry-only config, and the invariants the rest of the SDK relies on
 * (registryNetwork, the not-deployed sentinel, checksummed literals).
 */
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import {
  BNB,
  BNB_TESTNET,
  CELO,
  CELO_SEPOLIA,
  ETHEREUM,
  KEYSTORE_CACHE_UNSET,
  RELAY_URL,
  SEPOLIA,
  TESTNET_RELAY_URL,
  registryNetwork,
  type NetworkConfig,
} from "./config.js";

describe("SEPOLIA (registry only)", () => {
  test("carries the testnet KeyStore and no relay", () => {
    expect(SEPOLIA.chainId).toBe(11155111);
    expect(SEPOLIA.chain.id).toBe(11155111);
    expect(SEPOLIA.keyStore).toBe("0x38Aaf396F462Ad3a4F38ADa653AF6bDEA55F772d");
    expect(SEPOLIA.keyStoreController).toBe("0xc1525B766c134f7EB5B1d8e4a69C6Cb97Aff2379");
    expect(SEPOLIA.relayUrl).toBeUndefined();
    expect(SEPOLIA.registry).toBeUndefined();
    expect(SEPOLIA.explorer).toBe("https://sepolia.etherscan.io");
  });
});

describe("CELO_SEPOLIA (cached registry on Sepolia)", () => {
  test("executes through the testnet relay with its registry on Sepolia", () => {
    expect(CELO_SEPOLIA.chainId).toBe(11142220);
    expect(CELO_SEPOLIA.chain.id).toBe(11142220);
    expect(CELO_SEPOLIA.relayUrl).toBe(TESTNET_RELAY_URL);
    expect(CELO_SEPOLIA.registry?.kind).toBe("cached");
    if (CELO_SEPOLIA.registry?.kind !== "cached") throw new Error("unreachable");
    expect(CELO_SEPOLIA.registry.l1).toBe(SEPOLIA);
    expect(CELO_SEPOLIA.explorer).toBe("https://sepolia.celoscan.io");
  });

  test("keyStore / keyStoreController mirror the registry chain's contracts", () => {
    expect(CELO_SEPOLIA.keyStore).toBe(SEPOLIA.keyStore);
    expect(CELO_SEPOLIA.keyStoreController).toBe(SEPOLIA.keyStoreController);
  });

  test("the cache address is a checksummed address (sentinel until deployed)", () => {
    if (CELO_SEPOLIA.registry?.kind !== "cached") throw new Error("unreachable");
    const cache = CELO_SEPOLIA.registry.keyStoreCache;
    expect(cache).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(getAddress(cache)).toBe(cache);
  });
});

describe("CELO (mainnet shape, cache pending)", () => {
  test("registry on Ethereum, mainnet relay, cache sentinel", () => {
    expect(CELO.chainId).toBe(42220);
    expect(CELO.relayUrl).toBe(RELAY_URL);
    expect(CELO.keyStore).toBe(ETHEREUM.keyStore);
    expect(CELO.keyStoreController).toBe(ETHEREUM.keyStoreController);
    if (CELO.registry?.kind !== "cached") throw new Error("CELO must be a cached network");
    expect(CELO.registry.l1).toBe(ETHEREUM);
    expect(CELO.registry.keyStoreCache).toBe(KEYSTORE_CACHE_UNSET);
    expect(CELO.explorer).toBe("https://celoscan.io");
  });
});

describe("registryNetwork", () => {
  test("returns the network itself for local registries", () => {
    for (const n of [BNB, ETHEREUM, BNB_TESTNET, SEPOLIA]) {
      expect(registryNetwork(n)).toBe(n);
    }
  });

  test("returns the L1 for cached registries", () => {
    expect(registryNetwork(CELO_SEPOLIA)).toBe(SEPOLIA);
    expect(registryNetwork(CELO)).toBe(ETHEREUM);
  });

  test("a spread override keeps the registry", () => {
    const custom: NetworkConfig = { ...CELO_SEPOLIA, publicRpcUrl: "http://localhost:8545" };
    expect(registryNetwork(custom)).toBe(SEPOLIA);
  });
});

describe("existing networks are untouched", () => {
  test("BNB, ETHEREUM and BNB_TESTNET have no registry field (local by default)", () => {
    expect(BNB.registry).toBeUndefined();
    expect(ETHEREUM.registry).toBeUndefined();
    expect(BNB_TESTNET.registry).toBeUndefined();
  });

  test("the unset placeholder is the zero address", () => {
    expect(KEYSTORE_CACHE_UNSET).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("EIP-55", () => {
  test("every address literal in the configs is checksummed", () => {
    const configs = [BNB, ETHEREUM, BNB_TESTNET, SEPOLIA, CELO_SEPOLIA, CELO];
    for (const c of configs) {
      for (const addr of [c.keyStore, c.keyStoreController]) {
        expect(getAddress(addr)).toBe(addr);
      }
      if (c.registry?.kind === "cached") {
        expect(getAddress(c.registry.keyStoreCache)).toBe(c.registry.keyStoreCache);
      }
    }
  });
});
