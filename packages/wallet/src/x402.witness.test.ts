/**
 * B402 permit2-exact uses `permitWitnessTransferFrom` through the
 * x402ExactPermit2Proxy (`0x3038…`), binding the recipient via a witness. The
 * witness type string below is read VERBATIM from that proxy's on-chain
 * bytecode, so this is an independent EIP-712 oracle (hand-rolled keccak) for
 * the digest the proxy actually verifies.
 */
import { test, expect } from "bun:test";
import {
  keccak256,
  toHex,
  encodeAbiParameters,
  concatHex,
  hashTypedData,
  type Address,
  type Hex,
} from "viem";
import {
  PERMIT2_ADDRESS,
  buildPermit2TypedData,
  buildPermit2WitnessTypedData,
} from "./x402.js";

const USDC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
const PROXY: Address = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633"; // spenderAddress
const PAYTO: Address = "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA"; // witness.to
const amount = 10_000_000_000_000_000n;
const nonce = 42n;
const deadline = 1_900_000_000n;
const validAfter = 0n;
const chainId = 56;

const b32 = { type: "bytes32" } as const;
const addr = { type: "address" } as const;
const u256 = { type: "uint256" } as const;

/** Hand-rolled EIP-712 digest for PermitWitnessTransferFrom (independent of viem's hashTypedData). */
function handRolledWitnessDigest(): Hex {
  // Full type: PermitWitnessTransferFrom(...) + TokenPermissions(...) + Witness(...)
  const fullType =
    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)" +
    "TokenPermissions(address token,uint256 amount)" +
    "Witness(address to,uint256 validAfter)";
  const typeHash = keccak256(toHex(fullType));
  const tpHash = keccak256(
    encodeAbiParameters(
      [b32, addr, u256],
      [keccak256(toHex("TokenPermissions(address token,uint256 amount)")), USDC, amount],
    ),
  );
  const wHash = keccak256(
    encodeAbiParameters(
      [b32, addr, u256],
      [keccak256(toHex("Witness(address to,uint256 validAfter)")), PAYTO, validAfter],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [b32, b32, addr, u256, u256, b32],
      [typeHash, tpHash, PROXY, nonce, deadline, wHash],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [b32, b32, u256, addr],
      [
        keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)")),
        keccak256(toHex("Permit2")),
        BigInt(chainId),
        PERMIT2_ADDRESS,
      ],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

test("buildPermit2WitnessTypedData matches the proxy's PermitWitnessTransferFrom digest", () => {
  const td = buildPermit2WitnessTypedData({
    chainId,
    token: USDC,
    amount,
    spender: PROXY,
    nonce,
    deadline,
    to: PAYTO,
    validAfter,
  });
  expect(hashTypedData(td as any)).toBe(handRolledWitnessDigest());
});

test("witness digest differs from the plain PermitTransferFrom digest", () => {
  const w = hashTypedData(
    buildPermit2WitnessTypedData({
      chainId,
      token: USDC,
      amount,
      spender: PROXY,
      nonce,
      deadline,
      to: PAYTO,
      validAfter,
    }) as any,
  );
  const p = hashTypedData(
    buildPermit2TypedData({ chainId, token: USDC, amount, spender: PROXY, nonce, deadline }) as any,
  );
  expect(w).not.toBe(p);
});
