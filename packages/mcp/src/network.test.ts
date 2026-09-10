import { describe, expect, test } from "bun:test";
import {
  BNB,
  BNB_TESTNET,
  CELO,
  CELO_SEPOLIA,
  ETHEREUM,
  SEPOLIA,
} from "@altananetwork/sdk";
import {
  NETWORKS,
  SUPPORTED_CHAINS,
  describeNetwork,
  fundingSteps,
  resolveNetwork,
} from "./network.js";

describe("resolveNetwork", () => {
  test("names and chain ids resolve, case-insensitively", () => {
    expect(resolveNetwork("bnb").network).toBe(BNB);
    expect(resolveNetwork("56").network).toBe(BNB);
    expect(resolveNetwork("Ethereum").network).toBe(ETHEREUM);
    expect(resolveNetwork("1").network).toBe(ETHEREUM);
    expect(resolveNetwork("bnb-testnet").network).toBe(BNB_TESTNET);
    expect(resolveNetwork("bsc-testnet").network).toBe(BNB_TESTNET);
    expect(resolveNetwork("97").network).toBe(BNB_TESTNET);
    expect(resolveNetwork("celo").network).toBe(CELO);
    expect(resolveNetwork("42220").network).toBe(CELO);
    expect(resolveNetwork("CELO-SEPOLIA").network).toBe(CELO_SEPOLIA);
    expect(resolveNetwork("11142220").network).toBe(CELO_SEPOLIA);
  });

  test("defaults to BNB when unset, and falls back to BNB (flagged) when unknown", () => {
    expect(resolveNetwork(undefined)).toMatchObject({ network: BNB, requested: "bnb", recognized: true });
    expect(resolveNetwork("")).toMatchObject({ network: BNB, recognized: true });
    expect(resolveNetwork("sepolia")).toMatchObject({ network: BNB, requested: "sepolia", recognized: false });
  });

  test("the registry chain is the network itself for local registries and the L1 for cached ones", () => {
    expect(resolveNetwork("bnb").registry).toBe(BNB);
    expect(resolveNetwork("celo-sepolia").registry).toBe(SEPOLIA);
    expect(resolveNetwork("celo").registry).toBe(ETHEREUM);
  });

  test("every map entry has a relay (keystore-only chains are not selectable)", () => {
    for (const [name, network] of Object.entries(NETWORKS)) {
      expect(network.relayUrl, name).toBeTruthy();
    }
    expect(SUPPORTED_CHAINS).toContain("celo-sepolia");
  });
});

describe("describeNetwork", () => {
  test("local registries: chain only", () => {
    expect(describeNetwork(BNB)).toBe("BNB Smart Chain (chainId 56)");
  });

  test("Celo networks: names the KeyStore chain and the cache", () => {
    // viem names the chain "Celo Sepolia Testnet"; the description uses the
    // chain object's own name so it never drifts from what viem reports.
    expect(describeNetwork(CELO_SEPOLIA)).toBe(
      `${CELO_SEPOLIA.chain.name} (chainId 11142220); KeyStore on Sepolia (chainId 11155111); cache 0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD`,
    );
    expect(describeNetwork(CELO)).toBe(
      `${CELO.chain.name} (chainId 42220); KeyStore on Ethereum (chainId 1); cache ${CELO.registry?.kind === "cached" ? CELO.registry.keyStoreCache : ""}`,
    );
  });
});

describe("fundingSteps", () => {
  const addr = "0x0000000000000000000000000000000000000abc";

  test("mainnet: one step, no faucet", () => {
    const steps = fundingSteps(BNB, addr);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("Send some BNB to");
    expect(steps[0]).not.toContain("faucet");
  });

  test("bnb-testnet: faucet named", () => {
    expect(fundingSteps(BNB_TESTNET, addr)[0]).toContain("https://testnet.bnbchain.org/faucet-smart");
  });

  test("celo-sepolia: CELO faucet plus Sepolia ETH for the registry writes", () => {
    const steps = fundingSteps(CELO_SEPOLIA, addr);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain(`Send some ${CELO_SEPOLIA.chain.nativeCurrency.symbol} to`);
    expect(steps[0]).toContain("https://faucet.celo.org/celo-sepolia");
    expect(steps[1]).toContain("registry on Sepolia");
    expect(steps[1]).toContain("ETH");
    expect(steps[1]).toContain("cloud.google.com/application/web3/faucet/ethereum/sepolia");
  });

  test("celo mainnet: registry chain has a relay, so one step only", () => {
    expect(fundingSteps(CELO, addr)).toHaveLength(1);
  });
});
