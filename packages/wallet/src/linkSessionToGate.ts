import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import type { L2CacheConfig } from "./config.js";

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
