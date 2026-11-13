/**
 * What revoke_session says after a revoke, and whether the local session may
 * be forgotten.
 *
 * The SDK revokes a key on every chain of the environment that holds it and
 * answers for one of them: the network this server runs on. It throws when the
 * revoke failed there, so everything here is about a revoke that went through
 * on this network, with the other chains still to account for.
 */
import type { SessionLeg } from "@altananetwork/sdk";

/** A leg on another chain that did not end in a revoke. */
export type OtherChainLeg = { chainId: number; kind: SessionLeg["kind"]; reason: string };

export type RevokeReport = {
  /**
   * `revoked`: the key is revoked on this network and on every other chain
   * that could be read. `failed`: another chain holds the key and its revoke
   * did not go through.
   */
  status: "revoked" | "failed";
  /** Chains found holding the key (or listing it) whose revoke failed. The key still works there. */
  notRevokedOn: OtherChainLeg[];
  /** Chains that could not be read, so whether the key lives there is unknown. */
  notChecked: OtherChainLeg[];
  /** True when the local key and metadata can be deleted. */
  forgetLocal: boolean;
  /** One sentence for the caller when something is left to do. */
  note?: string;
};

/**
 * Reads the legs of a revoke that went through on this network.
 *
 * A chain that could not be read does not fail the call: the session lived on
 * this network, and it is revoked here. A chain where the key was found and
 * the revoke failed does, and the local session is kept so the revoke can be
 * run again by name.
 */
export function revokeReport(legs: readonly SessionLeg[]): RevokeReport {
  const failed = legs.filter((l) => l.status === "FAILED");
  const describe = (l: SessionLeg): OtherChainLeg => ({
    chainId: l.chainId,
    kind: l.kind,
    reason: l.reason ?? "failed",
  });
  const notChecked = failed.filter((l) => l.unread === true).map(describe);
  const notRevokedOn = failed.filter((l) => l.unread !== true).map(describe);
  const chains = (list: OtherChainLeg[]) => [...new Set(list.map((l) => l.chainId))].join(", ");

  if (notRevokedOn.length > 0) {
    return {
      status: "failed",
      notRevokedOn,
      notChecked,
      forgetLocal: false,
      note:
        `Revoked on this network, but not on chain ${chains(notRevokedOn)}. ` +
        `The local session was kept: run revoke_session again to finish.`,
    };
  }
  return {
    status: "revoked",
    notRevokedOn,
    notChecked,
    forgetLocal: true,
    ...(notChecked.length > 0
      ? {
          note:
            `Revoked on this network. Chain ${chains(notChecked)} could not be read, ` +
            `so it was not checked for this key.`,
        }
      : {}),
  };
}

/**
 * The message for a revoke that did not go through on this network. Nothing
 * local is deleted in that case.
 */
export function revokeFailureText(args: {
  sessionName: string;
  networkName: string;
  reason: string;
  legs: readonly SessionLeg[];
}): string {
  const lines = args.legs.map(
    (l) => `${l.kind} on chain ${l.chainId}: ${l.status}` + (l.reason ? ` (${l.reason})` : ""),
  );
  return (
    `The revoke of session "${args.sessionName}" did not go through on ${args.networkName}. ` +
    `The local session and its key were kept, so revoke_session can be run again. ` +
    `${args.reason}` +
    (lines.length > 0 ? `\nPer chain:\n- ${lines.join("\n- ")}` : "")
  );
}
