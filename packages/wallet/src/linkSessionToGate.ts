import {
  encodeFunctionData,
  keccak256,
  padHex,
  type Address,
  type Hex,
} from "viem";
import type { L2CacheConfig, NetworkConfig } from "./config.js";
import type { Session, SpendPermission } from "./internal/sessions.js";
import type { Signer } from "./internal/signer.js";
import { isPasskeySigner } from "./internal/passkey.js";
import { sessionKeyHash } from "./internal/erc1271.js";
import {
  buildPublicClient,
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * Wiring for KeyStoreCacheGate — the on-chain check that makes the L1 KeyStore
 * authoritative for a session key executing on an L2.
 *
 * Two calls are needed per gated session, and BOTH must originate from the
 * account itself:
 *
 *   1. setCallChecker(keyHash, target, gate) on the account. `onlyThis`, so it
 *      runs as a self-call inside an admin-signed intent — same shape as
 *      approveSignatureChecker.ts.
 *   2. link(keyHash, keyId) on the gate. The gate scopes every binding by
 *      msg.sender, so the caller must be the account, not an EOA acting for it.
 *
 * ---------------------------------------------------------------------------
 * WHY A GATED SESSION MUST NOT CARRY CALL PERMISSIONS
 *
 * GuardedExecutor.canExecute is an OR chain of "return true" conditions and it
 * consults call checkers LAST:
 *
 *     keyHash == 0            -> true
 *     isSuperAdmin            -> true
 *     key's own allowlist     -> true      <- gate never reached
 *     ANY_KEYHASH allowlist   -> true      <- gate never reached
 *     call checker (the gate) -> true
 *     return false
 *
 * So a `false` from the gate is an ABSTENTION, not a veto: it only decides the
 * outcome when nothing else already granted. Porto expands every entry in
 * `permissions.calls` into a `setCanExecute(keyHash, target, fnSel, true)` — an
 * allowlist entry that short-circuits the gate entirely. A session granted with
 * call permissions is therefore NOT protected by the gate, and revoking its key
 * on L1 does nothing.
 *
 * A gated session must express its limits through `permissions.spend` only,
 * which constrains how much rather than whether, and creates no allowlist entry.
 * assertGateIsSoleGrantPath() below verifies this on-chain after the fact.
 * ---------------------------------------------------------------------------
 */

const SET_CALL_CHECKER_ABI = [
  {
    name: "setCallChecker",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "checker", type: "address" },
    ],
    outputs: [],
  },
] as const;

const GATE_ABI = [
  {
    name: "link",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    name: "keyIdOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "keyHash", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const CAN_EXECUTE_INFOS_ABI = [
  {
    name: "canExecutePackedInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ type: "bytes32[]" }],
  },
] as const;

/** Account self-call routing `target` for this key through the gate. */
export function buildSetCallCheckerCall(args: {
  wallet: Address;
  keyHash: Hex;
  target: Address;
  gate: Address;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.wallet,
    value: 0n,
    data: encodeFunctionData({
      abi: SET_CALL_CHECKER_ABI,
      functionName: "setCallChecker",
      args: [args.keyHash, args.target, args.gate],
    }),
  };
}

/**
 * Binds the account-side keyHash to its canonical L1 keyId on the gate.
 * `keyId` is keccak256 of the public key bytes registered on L1.
 */
export function buildGateLinkCall(args: {
  gate: Address;
  keyHash: Hex;
  sessionPublicKey: Hex;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.gate,
    value: 0n,
    data: encodeFunctionData({
      abi: GATE_ABI,
      functionName: "link",
      args: [args.keyHash, keccak256(args.sessionPublicKey)],
    }),
  };
}

/**
 * Throws if the session's permissions would defeat the gate.
 *
 * Call this BEFORE granting. Any `permissions.calls` entry becomes a
 * setCanExecute allowlist entry that bypasses the gate, so a gated session must
 * use spend permissions only.
 */
export function assertGateCompatiblePermissions(permissions: {
  calls?: readonly unknown[];
  spend?: readonly unknown[];
}): void {
  if (permissions.calls && permissions.calls.length > 0) {
    throw new Error(
      "A gated session cannot carry `permissions.calls`. Each call permission " +
        "becomes a setCanExecute allowlist entry on the account, and " +
        "GuardedExecutor consults its allowlist BEFORE any call checker — so " +
        "the gate would never be asked and revoking the key on L1 would not " +
        "stop it. Express limits with `permissions.spend` instead, and scope " +
        "which targets are reachable via the gate's setCallChecker registration.",
    );
  }
}

/**
 * Post-grant verification, on-chain rather than by assumption. Confirms:
 *   - the account holds no allowlist entry for this key (so the gate is the
 *     only path that can grant), and
 *   - the gate binding is the one we intended (the contract documents that grant
 *     flows must read keyIdOf back, because a first-time link to an unclaimed
 *     keyHash is not authenticated).
 */
export async function assertGateIsSoleGrantPath(args: {
  publicClient: {
    readContract: (a: Record<string, unknown>) => Promise<unknown>;
  };
  wallet: Address;
  keyHash: Hex;
  gate: Address;
  expectedKeyId: Hex;
}): Promise<void> {
  const infos = (await args.publicClient.readContract({
    address: args.wallet,
    abi: CAN_EXECUTE_INFOS_ABI,
    functionName: "canExecutePackedInfos",
    args: [args.keyHash],
  })) as readonly Hex[];

  if (infos.length > 0) {
    throw new Error(
      `Session key ${args.keyHash} has ${infos.length} static allowlist ` +
        `entr${infos.length === 1 ? "y" : "ies"} on the account. Those are ` +
        `consulted before the gate, so L1 revocation would not stop this key. ` +
        `Grant the session with spend permissions only.`,
    );
  }

  const linked = (await args.publicClient.readContract({
    address: args.gate,
    abi: GATE_ABI,
    functionName: "keyIdOf",
    args: [args.wallet, args.keyHash],
  })) as Hex;

  if (linked.toLowerCase() !== args.expectedKeyId.toLowerCase()) {
    throw new Error(
      `Gate binding mismatch for ${args.keyHash}: gate reports ${linked}, ` +
        `expected ${args.expectedKeyId}. The binding is create-once and cannot ` +
        `be corrected — grant a fresh session key.`,
    );
  }
}

/** Convenience: the gate address for an L2, with a clear error when unset. */
export function requireGate(l2: L2CacheConfig): Address {
  if (!l2.keyStoreCacheGate) {
    throw new Error(
      `No KeyStoreCacheGate is configured for chain ${l2.chainId}. Session keys ` +
        `there are not subject to L1 revocation.`,
    );
  }
  return l2.keyStoreCacheGate;
}

// ---------------------------------------------------------------------------
// wireSessionToGateOnL2 — the first admin action on an L2 (the SDK-native
// replacement for the raw-viem bootstrap in the e2e scripts).
//
// ONE admin `submitCalls` whose calls run in strict order (ERC-7821 executes
// the array in order, so the ordering below is a contract guarantee):
//   1. authorize(session key)  — registers the key on the L2 account. Required
//      first: setSpendLimit and setCallChecker both call _isSuperAdmin(keyHash),
//      which reverts KeyDoesNotExist on an unknown key.
//   2. setSpendLimit           — bounds the session; touches only spend storage,
//      never the canExecute allowlist, so it does not defeat the gate.
//   3. setCallChecker          — routes `target` through the gate.
//   4. link                    — binds the account keyHash to the L1 keyId.
//
// It deliberately does NOT use `authorizeKeys`: Porto attaches a
// setCanExecute(keyHash, orchestrator, ANY_FN_SEL) call permission to any
// session key routed that way, which is an allowlist entry that bypasses the
// gate. The explicit authorize() call above installs the key with no such
// entry, so the gate stays the sole grant path.
//
// The ADMIN may be a passkey (submitCalls handles admin signing for both
// curves). The wired SESSION key must be secp256k1 (the account-side publicKey
// for a passkey session is a coordinate pair, not an address — out of scope
// here, and passkey sessions are separately unsupported on the execute path).
// ---------------------------------------------------------------------------

const AUTHORIZE_ABI = [
  {
    name: "authorize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const SET_SPEND_LIMIT_ABI = [
  {
    name: "setSpendLimit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "period", type: "uint8" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// GuardedExecutor.SpendPeriod enum.
const SPEND_PERIOD: Record<SpendPermission["period"], number> = {
  minute: 0,
  hour: 1,
  day: 2,
  week: 3,
  month: 4,
  year: 5,
};

/**
 * Account self-call: authorize a secp256k1 SESSION key on the L2 account. The
 * stored publicKey is the 20-byte address left-padded to 32 bytes (keyType 2).
 */
export function buildAuthorizeSessionKeyCall(args: {
  wallet: Address;
  sessionSigner: Signer;
  expiry: number;
}): { to: Address; value: bigint; data: Hex } {
  if (isPasskeySigner(args.sessionSigner)) {
    throw new Error(
      "wireSessionToGateOnL2 supports secp256k1 session keys only; the wired " +
        "session signer is a passkey. (A passkey ADMIN is fine.)",
    );
  }
  return {
    to: args.wallet,
    value: 0n,
    data: encodeFunctionData({
      abi: AUTHORIZE_ABI,
      functionName: "authorize",
      args: [
        {
          expiry: args.expiry,
          keyType: 2,
          isSuperAdmin: false,
          publicKey: padHex(args.sessionSigner.address, { size: 32 }),
        },
      ],
    }),
  };
}

/** Account self-call: set a spend limit for `keyHash`. */
export function buildSetSpendLimitCall(args: {
  wallet: Address;
  keyHash: Hex;
  token: Address;
  period: SpendPermission["period"];
  limit: bigint;
}): { to: Address; value: bigint; data: Hex } {
  return {
    to: args.wallet,
    value: 0n,
    data: encodeFunctionData({
      abi: SET_SPEND_LIMIT_ABI,
      functionName: "setSpendLimit",
      args: [args.keyHash, args.token, SPEND_PERIOD[args.period], args.limit],
    }),
  };
}

export type WireSessionToGateResult = {
  callsId: Hex;
  transactionHash?: Hex;
  keyHash: Hex;
  keyId: Hex;
};

/**
 * Perform the first admin action on an L2: authorize the session key on the L2
 * account, bound it with a spend limit, route `target` through the gate, and
 * link the account keyHash to the L1 keyId — all in one admin intent through the
 * relay (passkey-compatible admin, no raw viem).
 *
 * `target` is REQUIRED and must NOT be the ANY_TARGET wildcard: with ANY_TARGET
 * the gate is consulted for every destination including the gate itself, letting
 * a compromised session drive account->gate.link(...) and permanently poison
 * bindings. Pass the concrete contract(s) the session may call.
 */
export async function wireSessionToGateOnL2(
  wallet: { address: Address },
  adminSigner: Signer,
  session: Session,
  config: {
    network: NetworkConfig;
    gate: Address;
    target: Address;
    feeToken?: Address;
  },
): Promise<WireSessionToGateResult> {
  const { network, gate, target } = config;
  const feeToken = config.feeToken ?? NATIVE_TOKEN;

  // A gated session must be spend-only; call permissions become setCanExecute
  // allowlist entries that bypass the gate.
  assertGateCompatiblePermissions(session.permissions);

  const ANY_TARGET: Address = "0x3232323232323232323232323232323232323232";
  if (target.toLowerCase() === ANY_TARGET.toLowerCase()) {
    throw new Error(
      "wireSessionToGateOnL2: `target` must be a concrete address, not the " +
        "ANY_TARGET wildcard (it would let the session reach the gate itself).",
    );
  }

  const spend = session.permissions.spend ?? [];
  if (spend.length === 0) {
    throw new Error(
      "wireSessionToGateOnL2: the session has no spend permission. A gated " +
        "session must be bounded by spend limits, and the relay reverts " +
        "NoSpendPermissions if the fee token has no configured period.",
    );
  }

  const keyHash = sessionKeyHash(session);
  const keyId = keccak256(session.publicKey);

  const publicClient = buildPublicClient(network);

  // Re-run safety: the gate binding is create-once. If this keyHash is already
  // bound to the right keyId, skip `link` (a revoke->re-authorize on the L2
  // wipes the account's spend/checker state but the gate binding survives).
  const existingKeyId = (await publicClient.readContract({
    address: gate,
    abi: GATE_ABI,
    functionName: "keyIdOf",
    args: [wallet.address, keyHash],
  })) as Hex;
  const alreadyLinked =
    existingKeyId.toLowerCase() === keyId.toLowerCase();
  const zero =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
  if (
    existingKeyId.toLowerCase() !== zero &&
    existingKeyId.toLowerCase() !== keyId.toLowerCase()
  ) {
    throw new Error(
      `Gate already binds ${keyHash} to a different keyId (${existingKeyId}). ` +
        `Bindings are create-once; grant a fresh session key.`,
    );
  }

  const calls: { to: Address; value: bigint; data: Hex }[] = [
    buildAuthorizeSessionKeyCall({
      wallet: wallet.address,
      sessionSigner: session.signer,
      expiry: session.expiry,
    }),
    ...spend.map((s) =>
      buildSetSpendLimitCall({
        wallet: wallet.address,
        keyHash,
        token: s.token ?? NATIVE_TOKEN,
        period: s.period,
        limit: s.limit,
      }),
    ),
    buildSetCallCheckerCall({ wallet: wallet.address, keyHash, target, gate }),
    ...(alreadyLinked
      ? []
      : [buildGateLinkCall({ gate, keyHash, sessionPublicKey: session.publicKey })]),
  ];

  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  const relayClient = buildRelayClient(network);
  const callsId = await submitCalls(relayClient, wallet.address, adminSigner, calls, {
    feeToken,
    submittingKey: adminKeyDesc,
    network,
  });
  const result = await waitForCalls(relayClient, callsId);
  if (result.status !== "CONFIRMED") {
    throw new Error(
      `wireSessionToGateOnL2: relay status ${result.status} (callsId ${callsId}).`,
    );
  }

  return {
    callsId,
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
    keyHash,
    keyId,
  };
}
