import { encodeFunctionData, type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import {
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";
import { sessionKeyHash } from "./internal/erc1271.js";
import type { Session } from "./internal/sessions.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

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

/**
 * Build the `setSignatureCheckerApproval(sessionKeyHash, checker, isApproved)`
 * self-call. `setSignatureCheckerApproval` is `onlyThis`, so it must run as a
 * call from the account on itself — i.e. inside an admin-signed intent.
 */
export function buildSetCheckerApprovalCall(args: {
  wallet: Address;
  session: Session;
  checker: Address;
  isApproved: boolean;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.wallet,
    value: 0n,
    data: encodeFunctionData({
      abi: SET_CHECKER_ABI,
      functionName: "setSignatureCheckerApproval",
      args: [sessionKeyHash(args.session), args.checker, args.isApproved],
    }),
  };
}

/**
 * Authorize `checker` to validate ERC-1271 signatures produced by `session`.
 *
 * Without this, IthacaAccount's `isValidSignature` refuses a session key's
 * signature (only super-admin keys pass by default). `checker` MUST be the
 * contract that actually calls `isValidSignature` on the wallet — a DEX
 * settlement contract, Permit2, or an EIP-3009 token — since the account gates
 * on `msg.sender`.
 */
async function setChecker(
  wallet: Wallet,
  adminSigner: Signer,
  opts: { session: Session; checker: Address; isApproved: boolean },
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<ExecuteResult> {
  const network = config.network;
  const feeToken = config.feeToken ?? NATIVE_TOKEN;

  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  const call = buildSetCheckerApprovalCall({
    wallet: wallet.address,
    session: opts.session,
    checker: opts.checker,
    isApproved: opts.isApproved,
  });

  const relayClient = buildRelayClient(network);
  const callsId = await submitCalls(
    relayClient,
    wallet.address,
    adminSigner,
    [call],
    { feeToken, submittingKey: adminKeyDesc, network },
  );

  const result = await waitForCalls(relayClient, callsId);
  return {
    callsId,
    status: result.status as ExecuteResult["status"],
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

/** Approve a protocol contract to validate this session's ERC-1271 signatures. */
export function approveSignatureChecker(
  wallet: Wallet,
  adminSigner: Signer,
  opts: { session: Session; checker: Address },
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<ExecuteResult> {
  return setChecker(
    wallet,
    adminSigner,
    { ...opts, isApproved: true },
    config,
  );
}

/** Revoke a previously-approved checker for this session (keeps the session). */
export function revokeSignatureChecker(
  wallet: Wallet,
  adminSigner: Signer,
  opts: { session: Session; checker: Address },
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<ExecuteResult> {
  return setChecker(
    wallet,
    adminSigner,
    { ...opts, isApproved: false },
    config,
  );
}
