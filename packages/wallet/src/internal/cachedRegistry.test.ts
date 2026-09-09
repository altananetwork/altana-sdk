/**
 * Cached-registry helpers: which networks are cached, where their cache is,
 * how a registry write reaches the registry chain, and the funding check
 * that precedes a direct (EOA) write. No network I/O.
 */
import { describe, expect, test } from "bun:test";
import { parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BNB,
  BNB_TESTNET,
  CELO,
  CELO_SEPOLIA,
  ETHEREUM,
  KEYSTORE_CACHE_UNSET,
  SEPOLIA,
  type NetworkConfig,
} from "../config.js";
import { createHeadlessPasskey } from "./passkey.js";
import { createPrivateKeySigner, signerFromPrivateKey } from "./signer.js";
import {
  assertRegistryFunding,
  isCachedRegistry,
  keyStoreCacheOf,
  planRegistryWrite,
  provisioningNetworks,
} from "./cachedRegistry.js";

const DEPLOYED_CACHE: Address = "0x37ebf8F17c3705568a03fB3A1629AcE7B3D95FFf";

/** CELO_SEPOLIA with a different cache address, to check the helper reads the config. */
const CELO_SEPOLIA_LIVE: NetworkConfig = {
  ...CELO_SEPOLIA,
  registry: { kind: "cached", l1: SEPOLIA, keyStoreCache: DEPLOYED_CACHE },
};

describe("isCachedRegistry", () => {
  test("true for Celo networks, false for local registries", () => {
    expect(isCachedRegistry(CELO_SEPOLIA)).toBe(true);
    expect(isCachedRegistry(CELO)).toBe(true);
    expect(isCachedRegistry(BNB)).toBe(false);
    expect(isCachedRegistry(ETHEREUM)).toBe(false);
    expect(isCachedRegistry(BNB_TESTNET)).toBe(false);
    expect(isCachedRegistry(SEPOLIA)).toBe(false);
  });
});

describe("keyStoreCacheOf", () => {
  test("returns the cache address of a cached network", () => {
    expect(keyStoreCacheOf(CELO_SEPOLIA_LIVE)).toBe(DEPLOYED_CACHE);
  });

  test("refuses an unset cache address with a message naming the chain and the field", () => {
    expect(CELO.registry?.kind === "cached" && CELO.registry.keyStoreCache).toBe(
      KEYSTORE_CACHE_UNSET,
    );
    expect(() => keyStoreCacheOf(CELO)).toThrow(/no KeyStoreCache address configured/);
    expect(() => keyStoreCacheOf(CELO)).toThrow(/registry\.keyStoreCache/);
    expect(keyStoreCacheOf(CELO_SEPOLIA)).toBe("0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD");
  });

  test("refuses a local-registry network (there is no cache)", () => {
    expect(() => keyStoreCacheOf(BNB)).toThrow(/keeps its KeyStore locally/);
  });
});

describe("provisioningNetworks", () => {
  test("local networks pass through unchanged", () => {
    expect(provisioningNetworks([BNB, ETHEREUM])).toEqual([BNB, ETHEREUM]);
  });

  test("a cached network with a relay-less registry chain adds nothing (EOA writes)", () => {
    expect(provisioningNetworks([CELO_SEPOLIA])).toEqual([CELO_SEPOLIA]);
  });

  test("a cached network whose registry chain has a relay is provisioned there too, once", () => {
    expect(provisioningNetworks([CELO])).toEqual([CELO, ETHEREUM]);
    expect(provisioningNetworks([ETHEREUM, CELO])).toEqual([ETHEREUM, CELO]);
    expect(provisioningNetworks([CELO, BNB, ETHEREUM])).toEqual([CELO, ETHEREUM, BNB]);
  });
});

describe("planRegistryWrite", () => {
  const admin = createPrivateKeySigner();

  test("relay when the registry chain has one (Celo on Ethereum), for any signer", () => {
    const plan = planRegistryWrite(ETHEREUM, admin, admin.address);
    expect(plan.via).toBe("relay");
    const passkeyPlan = planRegistryWrite(ETHEREUM, createHeadlessPasskey(), "0x0000000000000000000000000000000000000001");
    expect(passkeyPlan.via).toBe("relay");
  });

  test("direct EOA transaction when the registry chain has no relay (Sepolia)", () => {
    const plan = planRegistryWrite(SEPOLIA, admin, admin.address);
    expect(plan.via).toBe("eoa");
    if (plan.via !== "eoa") throw new Error("unreachable");
    expect(plan.account.address).toBe(admin.address);
  });

  test("EOA path requires signer address == wallet address", () => {
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    expect(() => planRegistryWrite(SEPOLIA, admin, other.address)).toThrow(
      /is not the wallet address/,
    );
  });

  test("passkey admin on a relay-less registry chain throws the documented message", () => {
    const passkey = createHeadlessPasskey();
    expect(() =>
      planRegistryWrite(SEPOLIA, passkey, "0x0000000000000000000000000000000000000001"),
    ).toThrow(/passkey \(P256\) admin cannot sign one/);
    expect(() =>
      planRegistryWrite(SEPOLIA, passkey, "0x0000000000000000000000000000000000000001"),
    ).toThrow(/register: false/);
  });

  test("a signer without a raw key on a relay-less registry chain is refused", () => {
    const real = signerFromPrivateKey(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const opaque = { type: real.type, address: real.address, publicKey: real.publicKey, signDigest: real.signDigest };
    expect(() => planRegistryWrite(SEPOLIA, opaque, real.address)).toThrow(/direct transactions/);
  });
});

describe("assertRegistryFunding", () => {
  const address: Address = "0x0000000000000000000000000000000000000abc";
  const fakeClient = (balance: bigint) => ({ getBalance: async () => balance });

  test("passes when the balance covers fee plus the gas allowance", async () => {
    await assertRegistryFunding(fakeClient(parseEther("0.01")), SEPOLIA, address, parseEther("0.0002"));
  });

  test("names the chain, the asset, the shortfall and the faucet when underfunded", async () => {
    let message = "";
    try {
      await assertRegistryFunding(fakeClient(0n), SEPOLIA, address, parseEther("0.0002"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Sepolia (chainId 11155111)");
    expect(message).toContain(address);
    expect(message).toContain("holds 0 ETH");
    expect(message).toContain("needs about 0.0012 ETH");
    expect(message).toContain("cloud.google.com/application/web3/faucet/ethereum/sepolia");
  });

  test("mainnet registry chains get no faucet line", async () => {
    let message = "";
    try {
      await assertRegistryFunding(fakeClient(0n), ETHEREUM, address, 0n);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("Ethereum (chainId 1)");
    expect(message).not.toContain("faucet");
  });
});
