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
 * Build the `setSignatureCheckerApproval(keyHash, checker, isApproved)`
 * self-call. `setSignatureCheckerApproval` is `onlyThis`, so it must run as a
 * call from the account on itself — i.e. inside an admin-signed intent.
 *
 * It also reverts `KeyDoesNotExist()` unless the account already holds the key,
 * which matters when the call rides in the same intent that authorizes it. The
 * relay applies `authorizeKeys` before the intent's own calls, so that works;
 * measured on live Celo Sepolia, tx
 * `0x178d30ee2f40d1d414feedba885721484734c3d5b2d2478ac3c7bff6b8699382`
 * authorized a session key and set both of its x402 approvals in one intent.
 */
export function buildSetCheckerApprovalCall(args: {
  wallet: Address;
  /** The key to approve the checker for; a Session, or its key hash. */
  session?: Session;
  keyHash?: Hex;
  checker: Address;
  isApproved: boolean;
}): { to: Address; value: bigint; data: Hex } {
  const keyHash = args.keyHash ?? (args.session ? sessionKeyHash(args.session) : undefined);
  if (!keyHash) {
    throw new Error("buildSetCheckerApprovalCall: pass either `session` or `keyHash`.");
  }
  return {
    to: args.wallet,
    value: 0n,
    data: encodeFunctionData({
      abi: SET_CHECKER_ABI,
      functionName: "setSignatureCheckerApproval",
      args: [keyHash, args.checker, args.isApproved],
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
  // Undefined lets the relay charge whichever accepted token the wallet holds.
  const feeToken = config.feeToken;

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
    { ...(feeToken ? { feeToken } : {}), submittingKey: adminKeyDesc, network },
  );

  const result = await waitForCalls(relayClient, callsId);
  return {
    callsId,
    status: result.status as ExecuteResult["status"],
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
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
