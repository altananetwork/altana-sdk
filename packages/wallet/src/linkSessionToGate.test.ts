import { describe, expect, it } from "bun:test";
import { decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import {
  assertGateCompatiblePermissions,
  assertGateIsSoleGrantPath,
  buildGateLinkCall,
  buildSetCallCheckerCall,
  requireGate,
} from "./linkSessionToGate.js";
import { BASE, BASE_SEPOLIA } from "./config.js";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const GATE = "0x4A85DfdffA461A72F5625A6a7FBB764da2e7d1c7" as Address;
const TARGET = "0x000000000000000000000000000000000000cafe" as Address;
const KEY_HASH =
  "0xb9161da9e48d19867ef19003c94b1dd694e43ae89380150f530fe6af52e5eae8" as Hex;
const SESSION_PUBKEY = ("0x04" + "ab".repeat(64)) as Hex;

const SET_CALL_CHECKER_ABI = [
  {
    name: "setCallChecker",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "checker", type: "address" },
    ],
    outputs: [],
  },
] as const;

const LINK_ABI = [
  {
    name: "link",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

describe("buildSetCallCheckerCall", () => {
  it("targets the account itself, because setCallChecker is onlyThis", () => {
    const call = buildSetCallCheckerCall({
      wallet: WALLET,
      keyHash: KEY_HASH,
      target: TARGET,
      gate: GATE,
    });
    expect(call.to).toBe(WALLET);
    expect(call.value).toBe(0n);
  });

  it("encodes (keyHash, target, gate) in order", () => {
    const call = buildSetCallCheckerCall({
      wallet: WALLET,
      keyHash: KEY_HASH,
      target: TARGET,
      gate: GATE,
    });
    const decoded = decodeFunctionData({
      abi: SET_CALL_CHECKER_ABI,
      data: call.data,
    });
    expect(decoded.functionName).toBe("setCallChecker");
    expect(decoded.args[0]).toBe(KEY_HASH);
    expect((decoded.args[1] as string).toLowerCase()).toBe(
      TARGET.toLowerCase(),
    );
    expect((decoded.args[2] as string).toLowerCase()).toBe(GATE.toLowerCase());
  });
});

describe("buildGateLinkCall", () => {
  it("targets the gate and derives keyId as keccak256(publicKey)", () => {
    const call = buildGateLinkCall({
      gate: GATE,
      keyHash: KEY_HASH,
      sessionPublicKey: SESSION_PUBKEY,
    });
    expect(call.to).toBe(GATE);
    const decoded = decodeFunctionData({ abi: LINK_ABI, data: call.data });
    expect(decoded.args[0]).toBe(KEY_HASH);
    // keyId must match what the L1 KeyStore stores, which is keccak of the
    // registered public key bytes. Any drift here silently mislinks the session.
    expect(decoded.args[1]).toBe(keccak256(SESSION_PUBKEY));
  });
});

describe("assertGateCompatiblePermissions", () => {
  it("rejects call permissions, which would bypass the gate entirely", () => {
    expect(() =>
      assertGateCompatiblePermissions({
        calls: [{ to: TARGET, signature: "transfer(address,uint256)" }],
      }),
    ).toThrow(/cannot carry `permissions.calls`/);
  });

  it("allows spend-only permissions", () => {
    expect(() =>
      assertGateCompatiblePermissions({
        spend: [{ limit: 1n, period: "day" }],
      }),
    ).not.toThrow();
  });

  it("allows an empty calls array", () => {
    expect(() =>
      assertGateCompatiblePermissions({ calls: [], spend: [] }),
    ).not.toThrow();
  });
});

describe("assertGateIsSoleGrantPath", () => {
  const keyId = keccak256(SESSION_PUBKEY);

  function client(infos: readonly Hex[], linked: Hex) {
    return {
      readContract: async (a: Record<string, unknown>) =>
        a.functionName === "canExecutePackedInfos" ? infos : linked,
    };
  }

  it("passes when there is no allowlist entry and the link matches", async () => {
    await expect(
      assertGateIsSoleGrantPath({
        publicClient: client([], keyId),
        wallet: WALLET,
        keyHash: KEY_HASH,
        gate: GATE,
        expectedKeyId: keyId,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when the account holds a static allowlist entry", async () => {
    await expect(
      assertGateIsSoleGrantPath({
        publicClient: client(["0xdead" as Hex], keyId),
        wallet: WALLET,
        keyHash: KEY_HASH,
        gate: GATE,
        expectedKeyId: keyId,
      }),
    ).rejects.toThrow(/static allowlist/);
  });

  it("throws when the gate binding is not the intended keyId", async () => {
    await expect(
      assertGateIsSoleGrantPath({
        publicClient: client([], ("0x" + "11".repeat(32)) as Hex),
        wallet: WALLET,
        keyHash: KEY_HASH,
        gate: GATE,
        expectedKeyId: keyId,
      }),
    ).rejects.toThrow(/binding mismatch/);
  });
});

describe("requireGate", () => {
  it("returns the configured gate on Base Sepolia", () => {
    expect(requireGate(BASE_SEPOLIA)).toBe(
      BASE_SEPOLIA.keyStoreCacheGate as Address,
    );
  });

  it("throws for a chain with no gate deployed yet", () => {
    expect(() => requireGate(BASE)).toThrow(/No KeyStoreCacheGate/);
  });
});
