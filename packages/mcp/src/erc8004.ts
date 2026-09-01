/**
 * ERC-8004 registration orchestration for the MCP server.
 *
 * The SDK deliberately stops at primitives — it builds the calls, recovers the
 * minted agentId, and encodes registration files, but it does not decide what
 * goes in one or drive the two phases. That belongs to whoever owns the
 * agent's identity: BNB's runtime in the Studio flow, and this module in ours.
 *
 * Everything here is pure or dependency-injected so the tool logic is testable
 * without a relay: `runErc8004Registration` takes the two SDK writes as
 * arguments (defaulting to the real ones).
 */

import { toFunctionSelector, toHex, type Address, type Hex } from "viem";
import {
  encodeErc8004AgentUri,
  erc8004RegisterPermissions,
  registerErc8004Agent,
  setErc8004AgentUri,
  withErc8004Registration,
  type Erc8004MetadataEntry,
  type Erc8004RegistrationFile,
} from "@altananetwork/sdk";
import type { SessionPermissions } from "./sessions.js";

/** The structured fields the tools accept in place of a raw agent URI. */
export type AgentIdentityFields = {
  name: string;
  description: string;
  /** The agent's service URL — for A2A, its agent-card discovery document. */
  endpoint: string;
  /** Protocol name; "A2A" unless the agent speaks something else (e.g. "MCP"). */
  serviceName?: string;
  version?: string;
  image?: string;
};

/** Metadata as a tool caller supplies it: plain strings, hex-encoded on chain. */
export type MetadataInput = { key: string; value: string };

/**
 * Build a phase-1 registration file: no `registrations` entry, because the
 * agentId it would name does not exist until the mint assigns it.
 */
export function buildRegistrationFile(fields: AgentIdentityFields): Erc8004RegistrationFile {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: fields.name,
    description: fields.description,
    image: fields.image ?? "",
    services: [
      {
        name: fields.serviceName ?? "A2A",
        endpoint: fields.endpoint,
        ...(fields.version ? { version: fields.version } : {}),
      },
    ],
    registrations: [],
  };
}

/** Hex-encode caller-supplied metadata values for the registry's `bytes` field. */
export function toMetadataEntries(metadata?: readonly MetadataInput[]): Erc8004MetadataEntry[] {
  return (metadata ?? []).map((m) => ({ metadataKey: m.key, metadataValue: toHex(m.value) }));
}

/**
 * Which of the ERC-8004 permissions this session is missing, by signature.
 *
 * Checked client-side before submitting: an unscoped session key reverts at
 * the account's on-chain validator, which surfaces as an opaque failed intent
 * that has already cost gas. A session with no `calls` restriction at all can
 * call anything, so nothing is missing.
 *
 * A `{ to: registry }` entry with no signature satisfies the check — it really
 * does authorize the call on-chain. The SDK never emits one (it would also
 * authorize `transferFrom` and `setApprovalForAll` on the identity the wallet
 * owns), but a session granted elsewhere may carry it.
 */
export function missingErc8004Permissions(
  permissions: SessionPermissions | undefined,
  chainId: number,
): string[] {
  const granted = permissions?.calls;
  if (!granted || granted.length === 0) return [];

  return erc8004RegisterPermissions(chainId)
    .map((required) => required as { to: Address; signature: string })
    .filter(
      (required) =>
        !granted.some((granted_) => {
          // The union members carry `to`, `signature`, or both — widen to
          // the optional shape to compare without narrowing per arm.
          const g = granted_ as { to?: Address; signature?: string };
          return (
            (g.to === undefined || g.to.toLowerCase() === required.to.toLowerCase()) &&
            (g.signature === undefined || signatureMatches(g.signature, required.signature))
          );
        }),
    )
    .map((required) => required.signature);
}

/** A granted signature matches either as the text form or as its raw selector. */
function signatureMatches(granted: string, required: string): boolean {
  if (granted === required) return true;
  // Porto passes a raw hex selector through verbatim, so a session may have
  // been granted `0x…` instead of the human-readable signature.
  if (/^0x[0-9a-fA-F]{8}$/.test(granted)) {
    return granted.toLowerCase() === toFunctionSelector(required).toLowerCase();
  }
  return false;
}

/** Throw a tool-shaped error naming the session and what it would need. */
export function assertErc8004Permissions(
  sessionName: string,
  permissions: SessionPermissions | undefined,
  chainId: number,
): void {
  const missing = missingErc8004Permissions(permissions, chainId);
  if (missing.length === 0) return;
  throw new Error(
    `Session "${sessionName}" is not scoped for ERC-8004 identity: missing ${missing.join(" and ")}. ` +
      `Grant a session whose permissions.calls include erc8004RegisterPermissions(${chainId}) ` +
      `(the registry address plus those two selectors) and retry.`,
  );
}

// ---------------------------------------------------------------------------
// The two-phase flow
// ---------------------------------------------------------------------------

type WriteResult = { callsId: Hex; status: string; transactionHash?: Hex };

export type RegisterAgentFn = (
  session: unknown,
  params: { agentUri: string; metadata?: readonly Erc8004MetadataEntry[] },
  opts: unknown,
) => Promise<WriteResult & { agentId: bigint }>;

export type SetAgentUriFn = (
  session: unknown,
  params: { agentId: bigint; agentUri: string },
  opts: unknown,
) => Promise<WriteResult>;

export type Erc8004Writers = { registerAgent: RegisterAgentFn; setAgentUri: SetAgentUriFn };

const DEFAULT_WRITERS: Erc8004Writers = {
  registerAgent: registerErc8004Agent as unknown as RegisterAgentFn,
  setAgentUri: setErc8004AgentUri as unknown as SetAgentUriFn,
};

export type Erc8004RegistrationOutcome = {
  agentId: string;
  /** The record actually on chain: the completed one, or phase 1's if phase 2 failed. */
  agentUri: string;
  registrationFile: Erc8004RegistrationFile;
  registerTransactionHash?: Hex;
  setAgentUriTransactionHash?: Hex;
  /** False when the mint landed but the URI patch did not. */
  complete: boolean;
  message: string;
};

/**
 * Mint an identity and write the completed record back to it.
 *
 * Phase 2 failing is NOT treated as the whole thing failing: the token is
 * minted and paid for, so losing the agentId to an exception would strand it —
 * there is no reverse lookup to find it again. The outcome carries the id and
 * says how to repair, mirroring Studio's partial-registration semantics.
 */
export async function runErc8004Registration(
  args: {
    session: unknown;
    chainId: number;
    opts: unknown;
    file: Erc8004RegistrationFile;
    metadata?: readonly Erc8004MetadataEntry[];
  },
  writers: Erc8004Writers = DEFAULT_WRITERS,
): Promise<Erc8004RegistrationOutcome> {
  const phase1Uri = encodeErc8004AgentUri(args.file);
  const minted = await writers.registerAgent(
    args.session,
    { agentUri: phase1Uri, ...(args.metadata?.length ? { metadata: args.metadata } : {}) },
    args.opts,
  );

  const completed = withErc8004Registration(args.file, minted.agentId, args.chainId);
  const completedUri = encodeErc8004AgentUri(completed);

  try {
    const patched = await writers.setAgentUri(
      args.session,
      { agentId: minted.agentId, agentUri: completedUri },
      args.opts,
    );
    // Anything short of CONFIRMED is a partial registration: PENDING means the
    // relay wait ran out, and reporting that as done would tell the caller the
    // record is published when it may never land.
    if (patched.status !== "CONFIRMED") {
      throw new Error(`relay reported ${patched.status} (callsId ${patched.callsId})`);
    }
    return {
      agentId: minted.agentId.toString(),
      agentUri: completedUri,
      registrationFile: completed,
      ...(minted.transactionHash ? { registerTransactionHash: minted.transactionHash } : {}),
      ...(patched.transactionHash ? { setAgentUriTransactionHash: patched.transactionHash } : {}),
      complete: true,
      message: `Agent ${minted.agentId} registered. Read it back with erc8004_show.`,
    };
  } catch (e) {
    return {
      agentId: minted.agentId.toString(),
      agentUri: phase1Uri,
      registrationFile: args.file,
      ...(minted.transactionHash ? { registerTransactionHash: minted.transactionHash } : {}),
      complete: false,
      message:
        `Agent ${minted.agentId} was minted, but writing the completed record failed ` +
        `(${(e as Error).message}). Registration incomplete — run erc8004_set_agent_uri with ` +
        `agentId=${minted.agentId} to repair it. Do NOT register again; that would mint a second identity.`,
    };
  }
}
