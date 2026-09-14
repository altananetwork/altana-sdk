/**
 * submitCalls on a cached network (Celo Sepolia, Celo):
 *  - the admin's first-action KeyStore prepend is skipped (the registry is on
 *    another chain, and getKeys at a codeless address on Celo would throw);
 *  - any call aimed at the registry chain's KeyStore / Controller address is
 *    refused before anything reaches the relay, because on the cached network
 *    it would confirm as a plain transfer to a codeless address and burn the
 *    value it carried (the registration fee).
 * Plus the per-chain faucet map. No network I/O: the refusal fires before the
 * public-client read and the relay call.
 */
import { describe, expect, test } from "bun:test";
import { encodeFunctionData, parseEther, type Address } from "viem";
import { BNB, BNB_TESTNET, CELO, CELO_SEPOLIA, ETHEREUM, SEPOLIA } from "../config.js";
import { buildAdditionalRegisterCall, buildRevokeKeyCall } from "./keystore.js";
import {
  BNB_TESTNET_FAUCET_URL,
  CELO_SEPOLIA_FAUCET_URL,
  FAUCET_URLS,
  SEPOLIA_FAUCET_URL,
  assertNoRegistryTargets,
  buildRelayClient,
  faucetHint,
  isMissingRelayChainError,
  needsFirstActionPrepend,
  relayDoesNotServeChainMessage,
  submitCalls,
} from "./relay.js";
import { createPrivateKeySigner } from "./signer.js";

const PUBKEY = ("0x04" + "11".repeat(32) + "22".repeat(32)) as `0x${string}`;
const WALLET: Address = "0x0000000000000000000000000000000000000abc";

describe("needsFirstActionPrepend", () => {
  test("admins on local-registry networks prepend", () => {
    expect(needsFirstActionPrepend(BNB, "admin")).toBe(true);
    expect(needsFirstActionPrepend(ETHEREUM, "admin")).toBe(true);
    expect(needsFirstActionPrepend(BNB_TESTNET, "admin")).toBe(true);
  });

  test("sessions never prepend", () => {
    expect(needsFirstActionPrepend(BNB, "session")).toBe(false);
    expect(needsFirstActionPrepend(CELO_SEPOLIA, "session")).toBe(false);
  });

  test("admins on cached networks do not prepend (the registry is on another chain)", () => {
    expect(needsFirstActionPrepend(CELO_SEPOLIA, "admin")).toBe(false);
    expect(needsFirstActionPrepend(CELO, "admin")).toBe(false);
  });
});

describe("assertNoRegistryTargets", () => {
  const registerOnSepolia = buildAdditionalRegisterCall({
    publicKey: PUBKEY,
    fee: parseEther("0.0002"),
    network: SEPOLIA,
  });
  const revokeOnSepolia = buildRevokeKeyCall({
    walletAddress: WALLET,
    keyId: ("0x" + "ab".repeat(32)) as `0x${string}`,
    network: SEPOLIA,
  });

  test("refuses a registerKey aimed at the Controller on Celo Sepolia, explaining the fee burn", () => {
    expect(() => assertNoRegistryTargets(CELO_SEPOLIA, [registerOnSepolia])).toThrow(
      /KeyStoreController address of Sepolia \(chainId 11155111\)/,
    );
    expect(() => assertNoRegistryTargets(CELO_SEPOLIA, [registerOnSepolia])).toThrow(
      /plain transfer to a codeless address and burn its value \(200000000000000 wei here\)/,
    );
    expect(() => assertNoRegistryTargets(CELO_SEPOLIA, [registerOnSepolia])).toThrow(
      /grantSession, revokeSession or registerSessionKey/,
    );
  });

  test("refuses a revokeKey aimed at the KeyStore on Celo Sepolia", () => {
    expect(() => assertNoRegistryTargets(CELO_SEPOLIA, [revokeOnSepolia])).toThrow(
      /KeyStore address of Sepolia/,
    );
  });

  test("is case-insensitive on the target", () => {
    const lower = { ...registerOnSepolia, to: registerOnSepolia.to.toLowerCase() as Address };
    expect(() => assertNoRegistryTargets(CELO_SEPOLIA, [lower])).toThrow(/KeyStoreController/);
  });

  test("lets ordinary calls through on a cached network", () => {
    expect(() =>
      assertNoRegistryTargets(CELO_SEPOLIA, [{ to: WALLET, value: 1n, data: "0x" }]),
    ).not.toThrow();
  });

  test("never fires on local-registry networks (registry calls are legitimate there)", () => {
    const registerOnBnb = buildAdditionalRegisterCall({ publicKey: PUBKEY, fee: 1n, network: BNB });
    expect(() => assertNoRegistryTargets(BNB, [registerOnBnb])).not.toThrow();
    expect(() => assertNoRegistryTargets(SEPOLIA, [registerOnSepolia])).not.toThrow();
  });

  test("CELO refuses Ethereum's registry addresses", () => {
    const registerOnEthereum = buildAdditionalRegisterCall({ publicKey: PUBKEY, fee: 1n, network: ETHEREUM });
    expect(() => assertNoRegistryTargets(CELO, [registerOnEthereum])).toThrow(
      /KeyStoreController address of Ethereum \(chainId 1\)/,
    );
  });
});

describe("submitCalls on a cached network", () => {
  test("refuses registry targets before touching the relay or the RPC", async () => {
    // Unreachable endpoints: if the guard did not fire first, the failure
    // would be a connection error, not the refusal.
    const unreachable = {
      ...CELO_SEPOLIA,
      relayUrl: "http://127.0.0.1:9",
      publicRpcUrl: "http://127.0.0.1:9",
    };
    const admin = createPrivateKeySigner();
    const registerOnSepolia = buildAdditionalRegisterCall({
      publicKey: PUBKEY,
      fee: parseEther("0.0002"),
      network: SEPOLIA,
    });
    await expect(
      submitCalls(buildRelayClient(unreachable), admin.address, admin, [registerOnSepolia], {
        feeToken: "0x0000000000000000000000000000000000000000",
        submittingKey: { type: "secp256k1", publicKey: admin.publicKey, role: "admin" },
        network: unreachable,
      }),
    ).rejects.toThrow(/KeyStoreController address of Sepolia/);
  });

  test("the guard also covers raw calldata to the KeyStore (not only SDK builders)", () => {
    const data = encodeFunctionData({
      abi: [{ name: "getKeys", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32[]" }] }],
      functionName: "getKeys",
      args: [WALLET],
    });
    expect(() =>
      assertNoRegistryTargets(CELO_SEPOLIA, [{ to: CELO_SEPOLIA.keyStore, data }]),
    ).toThrow(/KeyStore address of Sepolia/);
  });
});

describe("relay prose", () => {
  test("buildRelayClient names both testnet chains when a network has no relay", () => {
    expect(() => buildRelayClient(SEPOLIA)).toThrow(
      /testnet relay serves BSC testnet \(97\) and Celo Sepolia \(11142220\)/,
    );
  });
});

describe("relay without the chain", () => {
  test("porto's destructuring TypeError is recognised and explained", () => {
    const portoError = new TypeError("Cannot destructure property 'contracts' from null or undefined value");
    expect(isMissingRelayChainError(portoError)).toBe(true);
    expect(isMissingRelayChainError(new Error("quote expired"))).toBe(false);
    const msg = relayDoesNotServeChainMessage(11142220, "https://testnet-relay.altana.network");
    expect(msg).toContain("does not serve chain 11142220");
    expect(msg).toContain("https://testnet-relay.altana.network");
    expect(msg).toContain("wallet_getCapabilities");
  });
});

describe("faucet map", () => {
  test("per-chain faucets", () => {
    expect(CELO_SEPOLIA_FAUCET_URL).toBe("https://faucet.celo.org/celo-sepolia");
    expect(faucetHint(11142220)).toBe(CELO_SEPOLIA_FAUCET_URL);
    expect(faucetHint(97)).toBe(BNB_TESTNET_FAUCET_URL);
    expect(faucetHint(11155111)).toBe(SEPOLIA_FAUCET_URL);
    expect(faucetHint(56)).toBeUndefined();
    expect(faucetHint(42220)).toBeUndefined();
    expect(Object.keys(FAUCET_URLS).map(Number).sort((a, b) => a - b)).toEqual([97, 11142220, 11155111]);
  });
});
