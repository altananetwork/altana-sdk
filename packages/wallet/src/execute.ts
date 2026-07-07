import type { Address, Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import { type Signer } from "./internal/signer.js";
import {
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type Call,
  type KeyDescriptor,
} from "./internal/relay.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";
import type { Session } from "./internal/sessions.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

export type ExecuteOptions = {
  /** Which chain to run on. Resolved by the client from a chainId. */
  network: NetworkConfig;
  feeToken?: Address;
  noWait?: boolean;
};

/**
 * Submit one or more calls from a wallet.
 *
 * Two call shapes:
 *   - execute(wallet, signer, calls, opts?)        // admin path
 *   - execute(session, calls, opts?)               // session path
 *
 * On the wallet's first execute (whichever path), this prepends a
 * KeyStoreController.initialRegisterKey call to register the admin key.
 * Detection is on-chain (single getActiveKeys read).
 */
export function execute(
  wallet: Wallet,
  signer: Signer,
  calls: Call | readonly Call[],
  opts: ExecuteOptions,
): Promise<ExecuteResult>;
export function execute(
  session: Session,
  calls: Call | readonly Call[],
  opts: ExecuteOptions,
): Promise<ExecuteResult>;
export async function execute(
  walletOrSession: Wallet | Session,
  signerOrCalls: Signer | Call | readonly Call[],
  callsOrOpts?: Call | readonly Call[] | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<ExecuteResult> {
  const isSessionCall = isSession(walletOrSession);

  const walletAddress = isSessionCall
    ? walletOrSession.walletAddress
    : walletOrSession.address;
  const signer = isSessionCall ? walletOrSession.signer : (signerOrCalls as Signer);
  const callsArg = isSessionCall
    ? (signerOrCalls as Call | readonly Call[])
    : (callsOrOpts as Call | readonly Call[]);
  const opts = (isSessionCall ? callsOrOpts : maybeOpts) as ExecuteOptions;

  const network = opts.network;
  const feeToken = opts.feeToken ?? NATIVE_TOKEN;

  const relayClient = buildRelayClient(network);
  const userCalls = Array.isArray(callsArg) ? callsArg : [callsArg as Call];

  // The key that's signing the intent — admin for the wallet path, session
  // for the session path. KeyStore first-action registration (if needed) is
  // injected inside submitCalls.
  const submittingKey: KeyDescriptor = isSessionCall
    ? {
        type: "secp256k1",
        publicKey: walletOrSession.publicKey,
        role: "session",
        expiry: walletOrSession.expiry,
        permissions: walletOrSession.permissions,
      }
    : {
        type: "secp256k1",
        publicKey: signer.publicKey,
        role: "admin",
      };

  const callsId = await submitCalls(relayClient, walletAddress, signer, userCalls, {
    feeToken,
    submittingKey,
    network,
  });

  if (opts?.noWait) {
    return { callsId, status: "PENDING" };
  }

  const result = await waitForCalls(relayClient, callsId);
  return {
    callsId,
    status: result.status as ExecuteResult["status"],
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}

function isSession(x: Wallet | Session): x is Session {
  return "walletAddress" in x;
}

export type { Call };
