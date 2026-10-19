import type { Address, Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import { type Signer } from "./internal/signer.js";
import {
  buildPublicClient,
  buildRelayClient,
  quoteCalls,
  submitCallsDetailed,
  waitForCalls,
  type Call,
  type CallsQuote,
  type KeyDescriptor,
  type RelayReceipt,
} from "./internal/relay.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";
import type { Session } from "./internal/sessions.js";
import { forgetAppLane, withAppLaneNonce } from "./internal/appNonceLane.js";
import { keyHashForSigner } from "./internal/erc1271.js";

export type ExecuteOptions = {
  /** Which chain to run on. Resolved by the client from a chainId. */
  network: NetworkConfig;
  /**
   * The token the relay fee is paid in. One address forces it. A list pays
   * with the first token the relay accepts on the chain and the wallet
   * holds, failing before anything is sent when none qualifies. Omitted, a
   * wallet key lets the relay charge whichever accepted token the wallet
   * holds, and a session key pays from its spend caps. `feeCurrencies()`
   * lists the accepted tokens; the token charged comes back as
   * `ExecuteResult.feeToken`.
   */
  feeToken?: Address | readonly Address[];
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
 * Detection is on-chain (single getKeys read).
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
  const { receipts: _receipts, ...result } = await executeWithReceipts(
    walletOrSession as Wallet,
    signerOrCalls as Signer,
    callsOrOpts as readonly Call[],
    maybeOpts as ExecuteOptions,
  );
  return result;
}

/** An ExecuteResult plus the relay's status receipts, when it reported any. */
export type ExecuteWithReceiptsResult = ExecuteResult & {
  receipts?: readonly RelayReceipt[];
};

/**
 * `execute`, but keeping the relay's status receipts on the result.
 *
 * Internal (not exported from the package index): the receipts are a raw
 * relay shape, and only flows that must recover a value from an event —
 * `registerErc8004Agent` reading its minted agentId out of `Registered` — need
 * them. Everything else uses `execute`, whose result stays a plain
 * ExecuteResult.
 */
export async function executeWithReceipts(
  walletOrSession: Wallet | Session,
  signerOrCalls: Signer | Call | readonly Call[],
  callsOrOpts?: Call | readonly Call[] | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<ExecuteWithReceiptsResult> {
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

  // An app transaction runs on the lane of the key that signs it, so it never
  // contends for a nonce with the relay's background work on lane 0 -- a
  // grant's KeyStore registration pays for the L1 write with an intent from
  // this same account, and the relay reserves no nonce for one it has not
  // mined (evidence/2026-10-17-nonce-lanes.md) -- nor with another key acting
  // on the same wallet, which is on a lane of its own.
  //
  // `withAppLaneNonce` queues this key's own back-to-back transactions, because
  // a lane's counter is sequential: handing out two at once would move the
  // collision, not remove it. It passes `undefined` for a wallet that is not
  // delegated yet, where there is no account to ask and the relay's own choice
  // is the right one.
  const lane = {
    publicClient: buildPublicClient(network),
    wallet: walletAddress,
    chainId: network.chainId,
    keyHash: keyHashForSigner(signer),
  };

  return await withAppLaneNonce<ExecuteWithReceiptsResult>(lane, async (nonce, laneSeqKey) => {
    const { callsId, feeToken } = await submitCallsDetailed(
      relayClient,
      walletAddress,
      signer,
      userCalls,
      {
        ...(opts.feeToken ? { feeToken: opts.feeToken } : {}),
        ...(nonce !== undefined ? { nonce } : {}),
        submittingKey,
        network,
      },
    );
    const charged = feeToken ? { feeToken } : {};
    /** The chain is the authority once an intent of ours did not land. */
    const dropLane = () => forgetAppLane(lane.chainId, lane.wallet, laneSeqKey);

    if (opts?.noWait) {
      // The caller wanted to get on with it, so it gets PENDING now -- but the
      // LANE is held until the bundle settles. The account's counter does not
      // advance until the intent executes, so releasing here would hand the
      // next transaction a nonce the account has not reached.
      const settled = (async () => {
        const seen = await waitForCalls(relayClient, callsId).catch(() => undefined);
        if (!seen || seen.status !== "CONFIRMED") dropLane();
      })();
      return { result: { callsId, status: "PENDING" as const, ...charged }, settled };
    }

    const result = await waitForCalls(relayClient, callsId);
    if (result.status !== "CONFIRMED") dropLane();

    // A FAILED bundle with no receipt never reached a block: the relay refused
    // it at its own simulation and reports a bare status code, naming neither
    // the call nor the reason. Returned as a status it was indistinguishable
    // from an intent that landed and reverted, which is a different
    // investigation, and it is the shape a dropped nonce arrives in.
    if (result.status === "FAILED" && (result.receipts?.length ?? 0) === 0) {
      throw new Error(silentlyDroppedMessage({ callsId, nonce, lane: laneSeqKey, chainId: network.chainId, statusCode: result.statusCode }));
    }

    return {
      result: {
        callsId,
        status: result.status as ExecuteResult["status"],
        ...charged,
        ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
        ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
        ...(result.receipts ? { receipts: result.receipts } : {}),
      },
    };
  });
}

/**
 * What to say when the relay reports a bundle FAILED with no receipt anywhere.
 *
 * The status alone names nothing, and this is the exact shape a nonce the
 * account never reached arrives in, so the nonce and its lane belong in the
 * message: a reader can check `getNonce(lane)` against it in one call.
 */
function silentlyDroppedMessage(args: {
  callsId: Hex;
  nonce: bigint | undefined;
  lane: bigint;
  chainId: number;
  statusCode?: number;
}): string {
  const code = args.statusCode !== undefined ? ` (status code ${args.statusCode})` : "";
  const noncePart =
    args.nonce === undefined
      ? "the relay chose this intent's nonce, so the SDK cannot say which it was"
      : `nonce ${args.nonce} — counter ${args.nonce & ((1n << 64n) - 1n)} on lane 0x${args.lane.toString(16)}`;
  return (
    `The relay reported this transaction FAILED${code} with no receipt on any chain, so it never ` +
    `reached a block: it was refused before being broadcast, not reverted on chain. ` +
    `Bundle ${args.callsId} on chain ${args.chainId}, ${noncePart}. ` +
    `If the counter is ahead of what \`getNonce\` reports for that lane, the account never ` +
    `reached this nonce and the intent was dropped for it; the SDK has already discarded its ` +
    `view of the lane, so retrying re-reads the chain.`
  );
}

/**
 * What `execute` would be charged for these exact calls, from the relay's
 * quote, without signing or sending: the maximum fee and the token it is
 * charged in, the native value the calls carry, and what the wallet is short
 * by if anything. Same arguments as `execute`. Use it to size a send that
 * must leave room for the fee, instead of guessing a reserve.
 */
export function quoteExecute(wallet: Wallet, signer: Signer, calls: Call | readonly Call[], opts: ExecuteOptions): Promise<CallsQuote>;
export function quoteExecute(session: Session, calls: Call | readonly Call[], opts: ExecuteOptions): Promise<CallsQuote>;
export async function quoteExecute(
  walletOrSession: Wallet | Session,
  signerOrCalls: Signer | Call | readonly Call[],
  callsOrOpts?: Call | readonly Call[] | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<CallsQuote> {
  const { walletAddress, signer, userCalls, submittingKey, opts } = intentOf(walletOrSession, signerOrCalls, callsOrOpts, maybeOpts);
  return quoteCalls(buildRelayClient(opts.network), walletAddress, signer, userCalls, {
    ...(opts.feeToken ? { feeToken: opts.feeToken } : {}),
    submittingKey,
    network: opts.network,
  });
}

/** The intent both execute and quoteExecute describe, from either argument shape. */
function intentOf(
  walletOrSession: Wallet | Session,
  signerOrCalls: Signer | Call | readonly Call[],
  callsOrOpts?: Call | readonly Call[] | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
) {
  const isSessionCall = isSession(walletOrSession);
  const walletAddress = isSessionCall ? walletOrSession.walletAddress : walletOrSession.address;
  const signer = isSessionCall ? walletOrSession.signer : (signerOrCalls as Signer);
  const callsArg = isSessionCall ? (signerOrCalls as Call | readonly Call[]) : (callsOrOpts as Call | readonly Call[]);
  const opts = (isSessionCall ? callsOrOpts : maybeOpts) as ExecuteOptions;
  const userCalls = Array.isArray(callsArg) ? callsArg : [callsArg as Call];
  const submittingKey: KeyDescriptor = isSessionCall
    ? { type: "secp256k1", publicKey: walletOrSession.publicKey, role: "session", expiry: walletOrSession.expiry, permissions: walletOrSession.permissions }
    : { type: "secp256k1", publicKey: signer.publicKey, role: "admin" };
  return { walletAddress, signer, userCalls, submittingKey, opts };
}

function isSession(x: Wallet | Session): x is Session {
  return "walletAddress" in x;
}

export type { Call };
