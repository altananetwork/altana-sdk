/**
 * Chain resolution: Celo and Celo Sepolia keep their own KeyStore and resolve
 * to it. Base Sepolia has none, so "base-sepolia" resolves to the Sepolia
 * registry and names its cache, and encoded calls carry the registry chain's
 * id (the chain the host must sign on).
 */
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { CHAINS, L2_CACHES, buildRegisterCall, buildRevokeCall, resolveChain } from "./keystore.js";

const PUBKEY = ("0x04" + "11".repeat(32) + "22".repeat(32)) as `0x${string}`;

describe("resolveChain", () => {
  test("sepolia is a first-class chain", () => {
    const c = resolveChain("sepolia");
    expect(c.key).toBe("sepolia");
    expect(c.chainId).toBe(11155111);
    expect(c.keyStore).toBe("0x38Aaf396F462Ad3a4F38ADa653AF6bDEA55F772d");
    expect(c.controller).toBe("0xc1525B766c134f7EB5B1d8e4a69C6Cb97Aff2379");
    expect(c.explorerUrl).toBe("https://sepolia.etherscan.io");
    expect(c.currencySymbol).toBe("SepoliaETH");
    expect(resolveChain("11155111")).toBe(c);
  });

  test("celo-sepolia and 11142220 resolve to Celo Sepolia's own KeyStore", () => {
    for (const name of ["celo-sepolia", "11142220", "Celo-Sepolia"]) {
      const c = resolveChain(name);
      expect(c.key).toBe("celo-sepolia");
      expect(c.chainId).toBe(11142220);
      expect(c.keyStore).toBe("0xCC3df52B6aD826781AAD86EcEB1459ed0b1Ae3F6");
      expect(c.controller).toBe("0x54eAb49d805336DB8591BAAF9ac630D0A58Ad2cD");
      expect(c.currencySymbol).toBe("CELO");
      expect(c.l2).toBeUndefined();
    }
  });

  test("celo and 42220 resolve to Celo's own KeyStore", () => {
    for (const name of ["celo", "42220"]) {
      const c = resolveChain(name);
      expect(c.key).toBe("celo");
      expect(c.chainId).toBe(42220);
      expect(c.keyStore).not.toBe(CHAINS["ethereum"]!.keyStore);
      expect(c.l2).toBeUndefined();
    }
  });

  test("base-sepolia and 84532 resolve to the Sepolia registry", () => {
    for (const name of ["base-sepolia", "84532", "Base-Sepolia"]) {
      const c = resolveChain(name);
      expect(c.key).toBe("sepolia");
      expect(c.keyStore).toBe(CHAINS["sepolia"]!.keyStore);
      expect(c.controller).toBe(CHAINS["sepolia"]!.controller);
    }
  });

  // An L2 alias also names the mirror, because that is the whole difference
  // between it and naming the registry chain: more than one L2 can be rooted
  // in a registry, so "sepolia" cannot say which cache a proof is meant for.
  test("an L2 alias carries its cache; a chain with its own KeyStore does not", () => {
    expect(resolveChain("base-sepolia").l2).toEqual(L2_CACHES["base-sepolia"]!);
    expect(resolveChain("84532").l2?.chainId).toBe(84532);

    for (const name of ["sepolia", "ethereum", "bnb", "celo", "celo-sepolia"]) {
      expect(resolveChain(name).l2).toBeUndefined();
    }
  });

  test("Base Sepolia's cache is the deployed KeyStoreCacheOPStack contract", () => {
    expect(L2_CACHES["base-sepolia"]!.cache).toBe("0x37ebf8F17c3705568a03fB3A1629AcE7B3D95FFf");
  });

  test("existing names still resolve, unknown falls back to bnb", () => {
    expect(resolveChain(undefined).key).toBe("bnb");
    expect(resolveChain("bsc").key).toBe("bnb");
    expect(resolveChain("eth").key).toBe("ethereum");
    expect(resolveChain("tbnb").key).toBe("bnb-testnet");
    expect(resolveChain("base").key).toBe("bnb");
  });

  test("every configured address is checksummed", () => {
    for (const c of Object.values(CHAINS)) {
      expect(getAddress(c.keyStore)).toBe(c.keyStore);
      expect(getAddress(c.controller)).toBe(c.controller);
    }
  });
});

describe("encoded calls carry the chain that holds the registry", () => {
  test("register on base-sepolia targets the Sepolia controller with chainId 11155111", () => {
    const chain = resolveChain("base-sepolia");
    const call = buildRegisterCall({ chain, publicKey: PUBKEY, fee: 1n, role: "root" });
    expect(call.to).toBe(chain.controller);
    expect(call.chainId).toBe(11155111);
  });

  test("register on celo-sepolia targets Celo Sepolia's own controller with chainId 11142220", () => {
    const chain = resolveChain("celo-sepolia");
    const call = buildRegisterCall({ chain, publicKey: PUBKEY, fee: 1n, role: "root" });
    expect(call.to).toBe("0x54eAb49d805336DB8591BAAF9ac630D0A58Ad2cD");
    expect(call.chainId).toBe(11142220);
  });

  test("revoke on celo targets Celo's own KeyStore with chainId 42220", () => {
    const chain = resolveChain("celo");
    const call = buildRevokeCall({
      chain,
      user: "0x0000000000000000000000000000000000000abc",
      keyId: ("0x" + "ab".repeat(32)) as `0x${string}`,
    });
    expect(call.to).toBe(chain.keyStore);
    expect(call.chainId).toBe(42220);
  });
});
