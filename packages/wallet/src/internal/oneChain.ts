/**
 * The one-chain surface of `client.grantSession` and `client.revokeSession`.
 *
 * Both run the same legs as the multi-chain functions and report them the
 * same way. On top of that, a call that names one chain behaves the way a
 * single-chain call always has: it carries that chain's transaction hash, and
 * it throws when that chain's part did not go through, so a caller that does
 * not read `status` or `legs` cannot take a failure for a success.
 *
 * This lives in the client layer on purpose. `runGrantSession` and
 * `runRevokeSession` never throw for a failed leg, which is what quoting and
 * the multi-chain calls rely on.
 */

import type { Hex } from "viem";
import type { RevokeSessionResult } from "../revokeSession.js";
import { legDetail } from "./sessionLegs.js";
import type { GrantSessionResult, SessionLeg } from "./sessions.js";

/** `status=<STATUS> (relay code <N>)`, the form single-chain grants have always thrown. */
function relayStatusText(leg: SessionLeg | undefined): string {
  const detail = legDetail(leg);
  const code = detail?.statusCode !== undefined ? ` (relay code ${detail.statusCode})` : "";
  if (detail?.relayStatus !== undefined) return `status=${detail.relayStatus}${code}`;
  return `status=FAILED${code}` + (leg?.reason ? `: ${leg.reason}` : "");
}

/**
 * A grant on one chain: the result with the account leg's transaction hash, or
 * a throw when the account leg on `chainId` did not confirm.
 *
 * The account is the authority on whether the key may act, so it alone
 * decides. A registry or cache leg that failed after the account confirmed
 * leaves a live key; that is reported through `status`, `legs`,
 * `registration` and `cacheSync`, never thrown, because a caller that catches
 * a throw discards the session.
 *
 * What was thrown underneath is rethrown as it was, so its `cause` chain is
 * intact. A relay status that is not CONFIRMED throws
 * `Session grant did not confirm: status=<STATUS> (relay code <N>)`.
 */
export function oneChainGrant(result: GrantSessionResult, chainId: number): GrantSessionResult {
  const account = result.legs.find((l) => l.kind === "account" && l.chainId === chainId);
  if (account?.status === "CONFIRMED") {
    return account.transactionHash ? { ...result, transactionHash: account.transactionHash } : result;
  }
  const thrown = legDetail(account)?.error;
  if (thrown !== undefined) throw thrown;
  throw new Error(`Session grant did not confirm: ${relayStatusText(account)}`);
}

/**
 * Thrown by `client.revokeSession` when the revoke did not go through on the
 * chain the call named. `result` is the full outcome, every chain included:
 * the revoke may have confirmed elsewhere. `cause` is what was thrown
 * underneath, when the failure was a thrown error.
 */
export class SessionRevokeError extends Error {
  override readonly name = "SessionRevokeError";
  /** The chain the call named. */
  readonly chainId: number;
  /** Every leg of the revoke, as `revokeSession` would have returned it. */
  readonly result: RevokeSessionResult;

  constructor(message: string, args: { chainId: number; result: RevokeSessionResult; cause?: unknown }) {
    super(message, ...(args.cause !== undefined ? [{ cause: args.cause }] : []));
    this.chainId = args.chainId;
    this.result = args.result;
  }
}

/**
 * Status values `client.revokeSession` returned up to 0.9.0. Never returned
 * now: they stay in the type so a comparison written against them still
 * compiles. A revoke that would have read `FAILED` throws instead.
 */
export type LegacyRevokeStatus = "CONFIRMED" | "FAILED" | "PENDING";

/** What `client.revokeSession` returns. */
export type ClientRevokeSessionResult = Omit<RevokeSessionResult, "status"> & {
  /**
   * `revoked` when every leg on every chain confirmed or had nothing to do,
   * `failed` when a leg on a chain other than the one the call named failed
   * (`legs` says which). A failure on the named chain throws.
   */
  status: RevokeSessionResult["status"] | LegacyRevokeStatus;
  /** The relay's numeric status for the named chain's account leg, when it reported one. */
  statusCode?: number;
  /** The relay bundle id of the named chain's account leg, when one was sent. */
  callsId?: Hex;
};

/**
 * A revoke as seen from one chain: the result with that chain's account
 * transaction, or a `SessionRevokeError` when the account leg on `chainId` or
 * the registry leg on `registryChainId` failed.
 */
export function oneChainRevoke(
  result: RevokeSessionResult,
  chainId: number,
  registryChainId: number,
): ClientRevokeSessionResult {
  const account = result.legs.find((l) => l.kind === "account" && l.chainId === chainId);
  const registry = result.legs.find((l) => l.kind === "registry" && l.chainId === registryChainId);
  const failed = [account, registry].filter((l): l is SessionLeg => l?.status === "FAILED");
  if (failed.length > 0) {
    // A registry revoke that rode in the account leg's intent failed with it:
    // one failure, said once.
    const distinct = failed.filter(
      (l) => !(l.kind === "registry" && l.via === "bundled" && account?.status === "FAILED" && l.chainId === chainId),
    );
    const what = distinct
      .map((l) => {
        const detail = legDetail(l);
        const why = detail?.error !== undefined && l.reason ? l.reason : relayStatusText(l);
        return `${l.kind} leg on chain ${l.chainId}: ${why}`;
      })
      .join("; ");
    const cause = failed.map((l) => legDetail(l)?.error).find((e) => e !== undefined);
    throw new SessionRevokeError(
      `Session revoke did not confirm on chain ${chainId} (${what}). ` +
        `Calling revokeSession again is safe: it only acts on what is still pending.`,
      { chainId, result, ...(cause !== undefined ? { cause } : {}) },
    );
  }
  const detail = legDetail(account);
  return {
    ...result,
    ...(account?.transactionHash ? { transactionHash: account.transactionHash } : {}),
    ...(detail?.statusCode !== undefined ? { statusCode: detail.statusCode } : {}),
    ...(detail?.callsId !== undefined ? { callsId: detail.callsId } : {}),
  };
}
