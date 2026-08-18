/**
 * ERC-8004 agent identity — mint and maintain an on-chain identity for an
 * agent running on an Altana wallet.
 *
 * The ERC-8004 identity registry is a plain ERC-721 (`AgentIdentity`/`AGENT`,
 * UUPS proxy) deployed alongside the ERC-8183 stack — the same address
 * `erc8183Addresses(chainId).registry` already points at. `register` mints a
 * token to `msg.sender`; the token's `tokenURI` IS the agent's identity
 * record, and `setAgentURI` (owner-or-approved gated) updates it. Both are
 * `nonpayable` — no protocol fee, only gas.
 *
 * Why this exists: BNB Agent Studio agents on Altana wallets had to deploy
 * with `--skip-register`, because a bounded session key could not sign the
 * registry calls. Nothing about the signing model needed to change —
 * `register` and `setAgentURI` are ordinary contract calls, so a session
 * scoped with `erc8004RegisterPermissions` can make exactly those two calls
 * and nothing else on the registry. That distinction matters: the session
 * executes AS the wallet, which is the NFT's owner, so a registry-wide
 * `{ to: registry }` grant would also authorize `transferFrom` (steal the
 * identity), `setApprovalForAll` (an operator approval that outlives session
 * revocation) and `setAgentWallet` (identity poisoning). Scope by selector.
 *
 * Registration is two-phase, because the identity record embeds the very id
 * the mint assigns:
 *
 *   1. `registerErc8004Agent` with `registrations: []` → mints, and recovers
 *      the `agentId` from the `Registered` event in the relay's receipt.
 *   2. `withErc8004Registration` patches the id in →
 *      `setErc8004AgentUri` writes the completed record.
 *
 * The wallet package stays primitives. Whoever orchestrates the two phases
 * owns the registration file's bytes — BNB's runtime in the Studio flow, the
 * `erc8004_register` MCP tool in ours.
 */

import { encodeFunctionData, pad, toEventSelector, type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import { erc8183Addresses } from "./erc8183.js";
import { executeWithReceipts, type ExecuteOptions } from "./execute.js";
import { buildPublicClient, type Call, type RelayLog } from "./internal/relay.js";
import type { CallPermission, Session } from "./internal/sessions.js";
import type { Signer } from "./internal/signer.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";

/** One `MetadataEntry` of the registry's 2-arg `register` overload. */
export type Erc8004MetadataEntry = { metadataKey: string; metadataValue: Hex };

const REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentURI", type: "string" },
      {
        name: "metadata",
        type: "tuple[]",
        components: [
          { name: "metadataKey", type: "string" },
          { name: "metadataValue", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  { name: "setAgentURI", type: "function", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const REGISTERED_EVENT = {
  type: "event",
  name: "Registered",
  inputs: [
    { name: "agentId", type: "uint256", indexed: true },
    { name: "agentURI", type: "string", indexed: false },
    { name: "owner", type: "address", indexed: true },
  ],
} as const;

const REGISTERED_TOPIC = toEventSelector(REGISTERED_EVENT);

/**
 * The two function signatures a registering session must be scoped to.
 * `register` is overloaded three ways on the registry (`()`, `(string)`,
 * `(string,(string,bytes)[])`); this is the arity our builder encodes, and
 * the unit tests pin the two to each other by selector.
 */
const REGISTER_SIGNATURE = "register(string,(string,bytes)[])";
const SET_AGENT_URI_SIGNATURE = "setAgentURI(uint256,string)";

/** The `data:` URI scheme the registration file is published under. */
const DATA_URI_PREFIX = "data:application/json;base64,";

// ---------------------------------------------------------------------------
// Call builders — the unit-testable seam
// ---------------------------------------------------------------------------

/**
 * `register(agentURI, metadata)` — mints an identity token to `msg.sender`.
 * Through the relay that is the wallet itself: under EIP-7702 the account
 * code lives at the wallet's own address and self-executes user calls.
 */
export function buildErc8004RegisterCall(
  chainId: number,
  agentUri: string,
  metadata: readonly Erc8004MetadataEntry[] = [],
): Call {
  return {
    to: erc8183Addresses(chainId).registry,
    data: encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "register",
      args: [agentUri, metadata],
    }),
  };
}

/** `setAgentURI(agentId, newURI)` — owner-or-approved gated by the ERC-721. */
export function buildErc8004SetAgentUriCall(
  chainId: number,
  agentId: bigint,
  agentUri: string,
): Call {
  return {
    to: erc8183Addresses(chainId).registry,
    data: encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "setAgentURI",
      args: [agentId, agentUri],
    }),
  };
}

/**
 * The bounded capability: the exact two calls an agent needs to register and
 * maintain its identity, and nothing else on the registry.
 *
 * Each entry is `{ to, signature }` — AND semantics, so the session may call
 * that selector at that address only. Pass straight into
 * `grantSession({ permissions: { calls: erc8004RegisterPermissions(chainId) } })`,
 * alongside a small native spend limit for gas.
 *
 * Deliberately NOT a `{ to: registry }` catch-all, not even as a fallback: see
 * the module header for what a registry-wide grant would also authorize. If a
 * signature string ever fails downstream, replace it with the raw hex selector
 * (Porto passes hex through verbatim) — never with a to-only grant.
 *
 * Note the scope is per-selector, not per-agentId: a session holding these
 * permissions can rewrite the URI of ANY agent the wallet owns.
 */
export function erc8004RegisterPermissions(chainId: number): CallPermission[] {
  const registry = erc8183Addresses(chainId).registry;
  return [
    { to: registry, signature: REGISTER_SIGNATURE },
    { to: registry, signature: SET_AGENT_URI_SIGNATURE },
  ];
}

// ---------------------------------------------------------------------------
// agentId recovery
// ---------------------------------------------------------------------------

/**
 * Pull the minted agentId out of a relay receipt's logs.
 *
 * Both filters are load-bearing. The relay bundles intents, so one receipt can
 * carry another wallet's `Registered` from the same registry — hence matching
 * the indexed `owner` topic — and a different contract can emit an event with
 * the same topic0 — hence matching `log.address`.
 *
 * Returns undefined when nothing matches; the caller turns that into an error
 * that names the transaction.
 */
export function findRegisteredAgentId(
  logs: readonly RelayLog[],
  registry: Address,
  owner: Address,
): bigint | undefined {
  const registryLower = registry.toLowerCase();
  const ownerTopic = pad(owner.toLowerCase() as Hex, { size: 32 });
  for (const log of logs) {
    if (log.address?.toLowerCase() !== registryLower) continue;
    if (log.topics?.[0]?.toLowerCase() !== REGISTERED_TOPIC.toLowerCase()) continue;
    if (log.topics?.[2]?.toLowerCase() !== ownerTopic) continue;
    const agentIdTopic = log.topics[1];
    if (!agentIdTopic) continue;
    return BigInt(agentIdTopic);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type RegisterAgentParams = {
  /** The identity record — a `data:application/json;base64,…` URI. */
  agentUri: string;
  /** Optional on-chain metadata entries written in the same call. */
  metadata?: readonly Erc8004MetadataEntry[];
};

export type RegisterAgentResult = ExecuteResult & {
  /** The token id the registry minted — phase 2 patches this into the URI. */
  agentId: bigint;
};

/**
 * Mint an ERC-8004 identity for this wallet and return its agentId.
 *
 * Phase 1 of registration. The record you pass should carry
 * `registrations: []` — you cannot know the id before the mint assigns it.
 * Follow with `withErc8004Registration` + `setErc8004AgentUri` to complete it.
 *
 * The agentId comes from the `Registered` event in the relay's own status
 * receipt, so the call needs a confirmed one: `opts.noWait` is rejected.
 *
 * Overloads mirror `execute`: admin path (wallet + signer) or session path.
 */
export function registerErc8004Agent(
  wallet: Wallet,
  signer: Signer,
  params: RegisterAgentParams,
  opts: ExecuteOptions,
): Promise<RegisterAgentResult>;
export function registerErc8004Agent(
  session: Session,
  params: RegisterAgentParams,
  opts: ExecuteOptions,
): Promise<RegisterAgentResult>;
export async function registerErc8004Agent(
  walletOrSession: Wallet | Session,
  signerOrParams: Signer | RegisterAgentParams,
  paramsOrOpts?: RegisterAgentParams | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<RegisterAgentResult> {
  const isSessionCall = "walletAddress" in walletOrSession;
  const params = (isSessionCall ? signerOrParams : paramsOrOpts) as RegisterAgentParams;
  const opts = (isSessionCall ? paramsOrOpts : maybeOpts) as ExecuteOptions;
  const walletAddress = isSessionCall
    ? (walletOrSession as Session).walletAddress
    : (walletOrSession as Wallet).address;

  if (opts.noWait) {
    throw new Error(
      "erc8004: register needs a confirmed receipt to recover agentId — do not pass noWait",
    );
  }

  const chainId = opts.network.chainId;
  const registry = erc8183Addresses(chainId).registry;
  const call = buildErc8004RegisterCall(chainId, params.agentUri, params.metadata);

  const result = isSessionCall
    ? await executeWithReceipts(walletOrSession as Session, call, opts)
    : await executeWithReceipts(walletOrSession as Wallet, signerOrParams as Signer, call, opts);

  const { receipts, ...executeResult } = result;

  if (executeResult.status === "FAILED") {
    throw new Error(
      `erc8004: register reverted (callsId ${executeResult.callsId}${
        executeResult.transactionHash ? `, tx ${executeResult.transactionHash}` : ""
      }). A session key must hold erc8004RegisterPermissions(${chainId}) to call the registry.`,
    );
  }
  if (executeResult.status !== "CONFIRMED") {
    throw new Error(
      `erc8004: register did not confirm within the relay wait (status ${executeResult.status}, ` +
        `callsId ${executeResult.callsId}). The mint may still land — recover the agentId later ` +
        `from that callsId's receipt rather than registering a second identity.`,
    );
  }

  const logs = (receipts ?? []).flatMap((r) => r.logs ?? []);
  const agentId = findRegisteredAgentId(logs, registry, walletAddress);
  if (agentId === undefined) {
    throw new Error(
      `erc8004: register confirmed but no Registered event for ${walletAddress} at ${registry} ` +
        `was found in the relay's receipt (tx ${executeResult.transactionHash ?? "unknown"}, ` +
        `${logs.length} log(s) reported). Read the transaction's logs to recover the agentId.`,
    );
  }

  return { ...executeResult, agentId };
}

export type SetAgentUriParams = { agentId: bigint; agentUri: string };

/**
 * Rewrite an agent's identity record. Phase 2 of registration, and the
 * update-endpoint path afterwards. Owner-or-approved gated on-chain, so the
 * wallet must own `agentId`.
 *
 * Unlike `registerErc8004Agent` this reads nothing back, so `opts.noWait`
 * passes through.
 */
export function setErc8004AgentUri(
  wallet: Wallet,
  signer: Signer,
  params: SetAgentUriParams,
  opts: ExecuteOptions,
): Promise<ExecuteResult>;
export function setErc8004AgentUri(
  session: Session,
  params: SetAgentUriParams,
  opts: ExecuteOptions,
): Promise<ExecuteResult>;
export async function setErc8004AgentUri(
  walletOrSession: Wallet | Session,
  signerOrParams: Signer | SetAgentUriParams,
  paramsOrOpts?: SetAgentUriParams | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<ExecuteResult> {
  const isSessionCall = "walletAddress" in walletOrSession;
  const params = (isSessionCall ? signerOrParams : paramsOrOpts) as SetAgentUriParams;
  const opts = (isSessionCall ? paramsOrOpts : maybeOpts) as ExecuteOptions;

  const call = buildErc8004SetAgentUriCall(
    opts.network.chainId,
    params.agentId,
    params.agentUri,
  );

  const { receipts: _receipts, ...result } = isSessionCall
    ? await executeWithReceipts(walletOrSession as Session, call, opts)
    : await executeWithReceipts(walletOrSession as Wallet, signerOrParams as Signer, call, opts);
  return result;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read an agent's owner and identity record. There is no reverse lookup on the
 * registry — you need the agentId, which registration returns.
 */
export async function getErc8004Agent(
  network: NetworkConfig,
  agentId: bigint,
): Promise<{ owner: Address; agentUri: string }> {
  const publicClient = buildPublicClient(network);
  const registry = erc8183Addresses(network.chainId).registry;
  const [owner, agentUri] = await Promise.all([
    publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "ownerOf", args: [agentId] }),
    publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "tokenURI", args: [agentId] }),
  ]);
  return { owner, agentUri };
}

// ---------------------------------------------------------------------------
// Registration file
// ---------------------------------------------------------------------------

/**
 * The identity record itself, published on-chain as the token's URI.
 *
 * `registrations` binds the record back to the chain and registry it lives on
 * (`agentRegistry` is a CAIP-style `eip155:<chainId>:<registry>`), which is
 * what makes a fetched record self-verifying.
 */
export type Erc8004RegistrationFile = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  registrations: { agentId: number; agentRegistry: string }[];
};

/**
 * Canonical JSON: keys sorted at every depth, JSON.stringify's separators, and
 * every non-ASCII character escaped as `\uXXXX`.
 *
 * Byte-identical to `@bnbagent/sdk`'s `canonicalJson` (and to Python's
 * `json.dumps(x, sort_keys=True, separators=(",", ":"))`), so a record written
 * by this SDK hashes the same as one written by theirs. Do not "simplify" this
 * to a plain JSON.stringify.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error(`erc8004: registration files cannot contain non-finite numbers (got ${v}).`);
  }
  return v;
}

/**
 * Serialize a registration file to the `data:application/json;base64,…` URI.
 *
 * `btoa` rather than a Buffer: this runs in browsers too (passkey wallets),
 * and canonical JSON is pure ASCII by construction — every non-ASCII character
 * has already been escaped — so btoa's latin1 encoding is exact here.
 */
export function encodeErc8004AgentUri(file: Erc8004RegistrationFile): string {
  return DATA_URI_PREFIX + btoa(canonicalJson(file));
}

/**
 * Parse a `data:application/json;base64,…` agent URI back to its record.
 * Throws on any other URI scheme (an agent may publish an https record
 * instead) and on a payload that is not JSON.
 */
export function decodeErc8004AgentUri(uri: string): Erc8004RegistrationFile {
  if (!uri.startsWith(DATA_URI_PREFIX)) {
    throw new Error(
      `erc8004: not a base64 JSON data URI (expected a "${DATA_URI_PREFIX}" prefix, got "${uri.slice(0, 40)}…").`,
    );
  }
  // Records we write are ASCII, but a third party's may be raw UTF-8, so
  // decode the bytes properly rather than trusting atob's latin1 string.
  const bytes = Uint8Array.from(atob(uri.slice(DATA_URI_PREFIX.length)), (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(json) as Erc8004RegistrationFile;
  } catch (e) {
    throw new Error(`erc8004: agent URI payload is not valid JSON (${(e as Error).message}).`);
  }
}

/**
 * Phase 2's pure step: return a copy of the record with this chain's
 * registration entry set to `agentId`. Any entry for a different registry is
 * kept — one agent can be registered on several chains. The input is not
 * mutated.
 */
export function withErc8004Registration(
  file: Erc8004RegistrationFile,
  agentId: bigint,
  chainId: number,
): Erc8004RegistrationFile {
  if (agentId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `erc8004: agentId ${agentId} exceeds Number.MAX_SAFE_INTEGER and cannot be written to a ` +
        `registration file (the format, and @bnbagent's SDKs, use a JSON number).`,
    );
  }
  const agentRegistry = `eip155:${chainId}:${erc8183Addresses(chainId).registry}`;
  const others = (file.registrations ?? []).filter(
    (r) => r.agentRegistry.toLowerCase() !== agentRegistry.toLowerCase(),
  );
  return {
    ...file,
    registrations: [...others, { agentId: Number(agentId), agentRegistry }],
  };
}
