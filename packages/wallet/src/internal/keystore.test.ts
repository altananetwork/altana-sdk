/**
 * KeyStore call builders — the encodings grantSession / revokeSession /
 * registerSessionKey put on-chain. Asserted by decoding the calldata back
 * (same oracle pattern as approveSignatureChecker.test.ts).
 */
import { test, expect } from "bun:test";
import { decodeFunctionData, keccak256, type Hex } from "viem";
import { BNB } from "../config.js";
import {
  deriveKeyId,
  buildInitialRegisterCall,
  buildAdditionalRegisterCall,
  buildRevokeKeyCall,
} from "./keystore.js";

const CONTROLLER_ABI = [
  {
    name: "initialRegisterKey",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "keyId", type: "bytes32" },
      { name: "validator", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "publicKey", type: "bytes" },
      { name: "expiry", type: "uint40" },
    ],
    outputs: [],
  },
  {
    name: "registerKey",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "keyId", type: "bytes32" },
      { name: "validator", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "publicKey", type: "bytes" },
      { name: "expiry", type: "uint40" },
    ],
    outputs: [],
  },
] as const;

const KEYSTORE_ABI = [
  {
    name: "revokeKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

// 65-byte SEC1 uncompressed pubkey shape (0x04 || x || y).
const PUBKEY: Hex = ("0x04" + "11".repeat(32) + "22".repeat(32)) as Hex;
const FEE = 876_866_105_047_914n;

test("buildAdditionalRegisterCall encodes registerKey(keyId=keccak256(pub), 0x0, '0x', pub, expiry) with value=fee to the controller", () => {
  const call = buildAdditionalRegisterCall({
    publicKey: PUBKEY,
    fee: FEE,
    network: BNB,
    expiry: 1_800_000_000,
  });

  expect(call.to).toBe(BNB.keyStoreController);
  expect(call.value).toBe(FEE);

  const { functionName, args } = decodeFunctionData({
    abi: CONTROLLER_ABI,
    data: call.data,
  });
  expect(functionName).toBe("registerKey");
  expect(args![0]).toBe(keccak256(PUBKEY)); // keyId convention
  expect(args![0]).toBe(deriveKeyId(PUBKEY));
  expect(args![1]).toBe("0x0000000000000000000000000000000000000000"); // validator
  expect(args![2]).toBe("0x"); // metadata
  expect((args![3] as string).toLowerCase()).toBe(PUBKEY.toLowerCase());
  expect(args![4]).toBe(1_800_000_000); // uint40 expiry
});

test("buildAdditionalRegisterCall clamps expiry to uint40 and treats omitted expiry as 0", () => {
  const clamped = buildAdditionalRegisterCall({
    publicKey: PUBKEY,
    fee: FEE,
    network: BNB,
    expiry: 2 ** 48, // beyond uint40
  });
  const decodedClamped = decodeFunctionData({ abi: CONTROLLER_ABI, data: clamped.data });
  expect(decodedClamped.args![4]).toBe(2 ** 40 - 1);

  const open = buildAdditionalRegisterCall({ publicKey: PUBKEY, fee: FEE, network: BNB });
  const decodedOpen = decodeFunctionData({ abi: CONTROLLER_ABI, data: open.data });
  expect(decodedOpen.args![4]).toBe(0);
});

test("buildInitialRegisterCall encodes initialRegisterKey with expiry forced to 0 (root keys never expire)", () => {
  const call = buildInitialRegisterCall({ publicKey: PUBKEY, fee: FEE, network: BNB });

  expect(call.to).toBe(BNB.keyStoreController);
  expect(call.value).toBe(FEE);

  const { functionName, args } = decodeFunctionData({
    abi: CONTROLLER_ABI,
    data: call.data,
  });
  expect(functionName).toBe("initialRegisterKey");
  expect(args![0]).toBe(keccak256(PUBKEY));
  expect(args![4]).toBe(0);
});

test("buildRevokeKeyCall encodes KeyStore.revokeKey(wallet, keyId) with no value", () => {
  const WALLET = "0x1111111111111111111111111111111111111111" as const;
  const keyId = keccak256(PUBKEY);
  const call = buildRevokeKeyCall({ walletAddress: WALLET, keyId, network: BNB });

  expect(call.to).toBe(BNB.keyStore);
  expect(call.value).toBe(0n);

  const { functionName, args } = decodeFunctionData({
    abi: KEYSTORE_ABI,
    data: call.data,
  });
  expect(functionName).toBe("revokeKey");
  expect((args![0] as string).toLowerCase()).toBe(WALLET.toLowerCase());
  expect(args![1]).toBe(keyId);
});
