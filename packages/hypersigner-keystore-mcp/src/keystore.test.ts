/**
 * Chain resolution: Celo has no KeyStore of its own, so "celo" resolves to the
 * Ethereum registry and "celo-sepolia" to the Sepolia one, and encoded calls
 * carry the registry chain's id (the chain the host must sign on).
 */
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { CHAINS, buildRegisterCall, buildRevokeCall, resolveChain } from "./keystore.js";

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

  test("celo-sepolia and 11142220 resolve to the Sepolia registry", () => {
    expect(resolveChain("celo-sepolia")).toBe(CHAINS["sepolia"]!);
    expect(resolveChain("11142220")).toBe(CHAINS["sepolia"]!);
    expect(resolveChain("Celo-Sepolia")).toBe(CHAINS["sepolia"]!);
  });

  test("celo and 42220 resolve to the Ethereum registry", () => {
    expect(resolveChain("celo")).toBe(CHAINS["ethereum"]!);
    expect(resolveChain("42220")).toBe(CHAINS["ethereum"]!);
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

describe("encoded calls on a Celo alias carry the registry chain id", () => {
  test("register on celo-sepolia targets the Sepolia controller with chainId 11155111", () => {
    const chain = resolveChain("celo-sepolia");
    const call = buildRegisterCall({ chain, publicKey: PUBKEY, fee: 1n, role: "root" });
    expect(call.to).toBe(chain.controller);
    expect(call.chainId).toBe(11155111);
  });

  test("revoke on celo targets the Ethereum KeyStore with chainId 1", () => {
    const chain = resolveChain("celo");
    const call = buildRevokeCall({
      chain,
      user: "0x0000000000000000000000000000000000000abc",
      keyId: ("0x" + "ab".repeat(32)) as `0x${string}`,
    });
    expect(call.to).toBe(chain.keyStore);
    expect(call.chainId).toBe(1);
  });
});
