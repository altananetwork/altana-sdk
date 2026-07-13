import { test, expect } from "bun:test";
import { decodeFunctionData, maxUint256, type Address } from "viem";
import { PERMIT2_ADDRESS } from "./x402.js";
import { buildApproveTokenForPermit2Call } from "./approveTokenForPermit2.js";

const TOKEN: Address = "0x55d398326f99059fF775485246999027B3197955";

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

test("buildApproveTokenForPermit2Call approves Permit2 for max by default", () => {
  const call = buildApproveTokenForPermit2Call(TOKEN);
  expect(call.to).toBe(TOKEN);
  expect(call.value).toBe(0n);
  const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data });
  expect(decoded.functionName).toBe("approve");
  expect((decoded.args[0] as string).toLowerCase()).toBe(
    PERMIT2_ADDRESS.toLowerCase(),
  );
  expect(decoded.args[1]).toBe(maxUint256);
});

test("buildApproveTokenForPermit2Call honors an explicit amount", () => {
  const call = buildApproveTokenForPermit2Call(TOKEN, 500n);
  const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: call.data });
  expect(decoded.args[1]).toBe(500n);
});
