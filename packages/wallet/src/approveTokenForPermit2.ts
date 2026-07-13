import {
  encodeFunctionData,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";
import { execute } from "./execute.js";
import { PERMIT2_ADDRESS } from "./x402.js";

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

/**
 * Build the ERC20 `approve(Permit2, amount)` call. Permit2 pulls tokens via
 * `permitTransferFrom`, which requires the wallet to have approved Permit2
 * first. Defaults to an unlimited (maxUint256) allowance — the usual pattern,
 * since Permit2 enforces per-signature amounts on top.
 */
export function buildApproveTokenForPermit2Call(
  token: Address,
  amount: bigint = maxUint256,
): { to: Address; value: bigint; data: Hex } {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, amount],
    }),
  };
}

/**
 * One-time on-chain approval: let Permit2 move `token` for this wallet. Runs as
 * an admin-signed transaction through the relay.
 */
export function approveTokenForPermit2(
  wallet: Wallet,
  adminSigner: Signer,
  token: Address,
  config: { network: NetworkConfig; feeToken?: Address; amount?: bigint },
): Promise<ExecuteResult> {
  return execute(
    wallet,
    adminSigner,
    buildApproveTokenForPermit2Call(token, config.amount),
    {
      network: config.network,
      ...(config.feeToken ? { feeToken: config.feeToken } : {}),
    },
  );
}
