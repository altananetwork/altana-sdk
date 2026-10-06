import { describe, expect, test } from "bun:test";
import {
  BNB,
  BNB_TESTNET,
  CELO,
  CELO_SEPOLIA,
  ETHEREUM,
  SEPOLIA,
  BASE_SEPOLIA,
} from "@altananetwork/sdk";
import {
  NETWORKS,
  SUPPORTED_CHAINS,
  applyEndpointOverrides,
  describeNetwork,
  fundingSteps,
  networkGroup,
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

  test("a near miss for the testnet is not recognized, which is what makes it fatal", () => {
    /* The failure this guards: an unrecognised ALTANA_CHAIN used to log a
       warning and continue on BNB **mainnet**. A typo put an agent on a chain
       where the money is real, and the warning went to stderr, which on an MCP
       server is the host's log rather than anywhere the person who pasted the
       command looks. index.ts exits on `recognized: false` now, so this flag is
       load bearing rather than informational. */
    for (const typo of ["bnb_testnet", "bnbtestnet", "testnet", "bnb-test"]) {
      expect(resolveNetwork(typo).recognized).toBe(false);
    }

    // The real names still are, so the guard does not block the common case.
    // bsc-testnet is a deliberate alias, which this test asserted was a typo
    // until it ran.
    for (const good of ["bnb-testnet", "BNB-Testnet", "97", "bsc-testnet"]) {
      expect(resolveNetwork(good).recognized).toBe(true);
      expect(resolveNetwork(good).network.chainId).toBe(97);
    }

    // And whitespace is forgiven rather than fatal: a trailing space in a shell
    // or a config file is the value they meant.
    expect(resolveNetwork("bnb-testnet ").recognized).toBe(true);
    expect(resolveNetwork(" 97").network.chainId).toBe(97);
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

  test("celo-sepolia: the Sepolia registry is relayed now, so one step only (like celo mainnet)", () => {
    const steps = fundingSteps(CELO_SEPOLIA, addr);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain(`Send some ${CELO_SEPOLIA.chain.nativeCurrency.symbol} to`);
    expect(steps[0]).toContain("https://faucet.celo.org/celo-sepolia");
  });

  test("a relay-less registry chain adds the direct-write funding step", () => {
    const relayless = {
      ...CELO_SEPOLIA,
      registry: { kind: "cached" as const, l1: { ...SEPOLIA, relayUrl: undefined }, keyStoreCache: CELO_SEPOLIA.registry!.kind === "cached" ? CELO_SEPOLIA.registry!.keyStoreCache : "0x0000000000000000000000000000000000000000" as const },
    };
    const steps = fundingSteps(relayless, addr);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toContain("registry on Sepolia");
    expect(steps[1]).toContain("cloud.google.com/application/web3/faucet/ethereum/sepolia");
  });

  test("celo mainnet: registry chain has a relay, so one step only", () => {
    expect(fundingSteps(CELO, addr)).toHaveLength(1);
  });

  test("with the relay's fee tokens: names them as alternatives to the native token", () => {
    const native = CELO_SEPOLIA.chain.nativeCurrency.symbol;
    const [first] = fundingSteps(CELO_SEPOLIA, addr, { feeSymbols: [native, "USDC", "USDm"] });
    expect(first).toContain(`Send some ${native}, or any of USDC, USDm, to ${addr}`);
    expect(first).toContain("whichever of these tokens the wallet holds");
    expect(first).toContain("https://faucet.celo.org/celo-sepolia");
  });

  test("a relay that only takes the native token changes nothing", () => {
    const native = BNB.chain.nativeCurrency.symbol;
    expect(fundingSteps(BNB, addr, { feeSymbols: [native] })).toEqual(fundingSteps(BNB, addr));
  });
});

describe("networkGroup", () => {
  test("a testnet chain revokes across the whole testnet group", () => {
    expect(networkGroup(CELO_SEPOLIA).map((n) => n.chainId)).toEqual([97, 11142220, 84532]);
    expect(networkGroup(BNB_TESTNET)).toContain(BASE_SEPOLIA);
  });

  test("a mainnet chain revokes across the mainnet group", () => {
    expect(networkGroup(BNB).map((n) => n.chainId)).toEqual([56, 1, 42220]);
  });

  test("a chain outside both groups stands alone", () => {
    expect(networkGroup(SEPOLIA)).toEqual([SEPOLIA]);
  });
});

describe("pointing the server at a fork", () => {
  const FORK_RPC = "http://127.0.0.1:8599";
  const FORK_RELAY = "http://127.0.0.1:9199";

  test("leaves a network alone when neither override is set", () => {
    const network = applyEndpointOverrides(BNB_TESTNET, {});
    expect(network).toBe(BNB_TESTNET);
  });

  test("overrides the RPC and the relay", () => {
    const network = applyEndpointOverrides(BNB_TESTNET, {
      rpcUrl: FORK_RPC,
      relayUrl: FORK_RELAY,
    });
    expect(network.publicRpcUrl).toBe(FORK_RPC);
    expect(network.relayUrl).toBe(FORK_RELAY);
  });

  test("keeps the contract addresses, which forked state already carries", () => {
    const network = applyEndpointOverrides(BNB_TESTNET, { rpcUrl: FORK_RPC });
    expect(network.keyStore).toBe(BNB_TESTNET.keyStore);
    expect(network.keyStoreController).toBe(BNB_TESTNET.keyStoreController);
    expect(network.chainId).toBe(97);
  });

  test("ignores whitespace, rather than pointing at nowhere", () => {
    const network = applyEndpointOverrides(BNB_TESTNET, { rpcUrl: "   ", relayUrl: "" });
    expect(network.publicRpcUrl).toBe(BNB_TESTNET.publicRpcUrl);
  });

  test("overrides one endpoint without disturbing the other", () => {
    const network = applyEndpointOverrides(BNB_TESTNET, { relayUrl: FORK_RELAY });
    expect(network.relayUrl).toBe(FORK_RELAY);
    expect(network.publicRpcUrl).toBe(BNB_TESTNET.publicRpcUrl);
  });
});
