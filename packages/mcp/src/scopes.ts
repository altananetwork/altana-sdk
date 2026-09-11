/**
 * The `calls` permission a `grant_session` request turns into.
 *
 * Three ways to scope a session, mutually exclusive by construction:
 *
 *   - `scope`: a named preset that expands to the SDK's selector-scoped
 *     permission set for one protocol flow (`erc8004RegisterPermissions`,
 *     `erc8183SubmitPermissions`). The only way to hand a session the two
 *     registry calls ERC-8004 registration needs without also handing it
 *     `transferFrom` / `setApprovalForAll` on the identity the wallet owns.
 *   - `recipient` + `signatures`: one target, restricted to those selectors.
 *   - `recipient` alone: one target, any selector — the original shape.
 *
 * Pure so the tool's permission logic is testable without a relay.
 */

import type { Address } from "viem";
import { erc8004RegisterPermissions, erc8183SubmitPermissions } from "@altananetwork/sdk";

export const SESSION_SCOPES = ["erc8004-identity", "erc8183-seller"] as const;
export type SessionScope = (typeof SESSION_SCOPES)[number];

/** What the SDK's CallPermission looks like once a target is always present. */
export type GrantCallPermission = { to: Address; signature?: string };

export type GrantCallsInput = {
  chainId: number;
  recipient?: Address;
  signatures?: readonly string[];
  scope?: SessionScope;
};

const SIGNATURE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*\(.*\)$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

export function buildGrantCalls(input: GrantCallsInput): GrantCallPermission[] {
  const { chainId, recipient, signatures, scope } = input;

  if (scope !== undefined && recipient !== undefined) {
    throw new Error("grant_session: pass either `scope` or `recipient`, not both.");
  }
  if (scope === undefined && recipient === undefined) {
    throw new Error("grant_session: pass `scope` (a named preset) or `recipient` (a target address).");
  }
  if (signatures !== undefined && recipient === undefined) {
    throw new Error("grant_session: `signatures` restricts a `recipient`; it cannot be combined with `scope`.");
  }

  if (scope !== undefined) {
    switch (scope) {
      case "erc8004-identity":
        return erc8004RegisterPermissions(chainId) as GrantCallPermission[];
      case "erc8183-seller":
        return [...erc8183SubmitPermissions(chainId)];
      default: {
        const never: never = scope;
        throw new Error(`grant_session: unknown scope ${JSON.stringify(never)}.`);
      }
    }
  }

  if (signatures === undefined || signatures.length === 0) {
    return [{ to: recipient! }];
  }
  return signatures.map((signature) => {
    if (!SIGNATURE_RE.test(signature) && !SELECTOR_RE.test(signature)) {
      throw new Error(
        `grant_session: ${JSON.stringify(signature)} is not a function signature ` +
          `("transfer(address,uint256)") or a 4-byte selector ("0xa9059cbb").`,
      );
    }
    return { to: recipient!, signature };
  });
}
