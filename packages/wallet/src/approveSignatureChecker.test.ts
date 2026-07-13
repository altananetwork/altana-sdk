import { test, expect } from "bun:test";
import { decodeFunctionData, type Address } from "viem";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import { sessionKeyHash } from "./internal/erc1271.js";
import type { Session } from "./internal/sessions.js";
import { buildSetCheckerApprovalCall } from "./approveSignatureChecker.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const CHECKER: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // Permit2

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 0,
  };
}

const SET_CHECKER_ABI = [
  {
    name: "setSignatureCheckerApproval",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "checker", type: "address" },
      { name: "isApproved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

test("buildSetCheckerApprovalCall encodes setSignatureCheckerApproval as a self-call", () => {
  const session = makeSession(createPrivateKeySigner());
  const call = buildSetCheckerApprovalCall({
    wallet: WALLET,
    session,
    checker: CHECKER,
    isApproved: true,
  });

  expect(call.to).toBe(WALLET); // onlyThis → self-call
  expect(call.value).toBe(0n);

  const decoded = decodeFunctionData({ abi: SET_CHECKER_ABI, data: call.data });
  expect(decoded.functionName).toBe("setSignatureCheckerApproval");
  expect(decoded.args[0]).toBe(sessionKeyHash(session));
  expect((decoded.args[1] as string).toLowerCase()).toBe(CHECKER.toLowerCase());
  expect(decoded.args[2]).toBe(true);
});

test("buildSetCheckerApprovalCall encodes isApproved=false for revoke", () => {
  const session = makeSession(createPrivateKeySigner());
  const call = buildSetCheckerApprovalCall({
    wallet: WALLET,
    session,
    checker: CHECKER,
    isApproved: false,
  });
  const decoded = decodeFunctionData({ abi: SET_CHECKER_ABI, data: call.data });
  expect(decoded.args[2]).toBe(false);
});
