/**
 * The two approvals a session key needs before it can pay over x402, and the
 * check that says which one is missing.
 *
 * A payment from a smart account is an ERC-1271 signature, so some contract
 * calls `isValidSignature` on the wallet to verify it. `IthacaAccount` answers
 * that call like this:
 *
 * ```solidity
 * isValid = _isSuperAdmin(keyHash) || _getKeyExtraStorage(keyHash).checkers.contains(msg.sender);
 * ```
 *
 * So the account accepts a **session** key's signature only from a contract the
 * account has approved as a signature checker **for that key**. A super-admin
 * key needs no approval and is why an admin-signed payment works with nothing
 * set up. The checker is whoever makes the call: `Permit2` on the permit2 rails,
 * and the token itself on the eip3009 rail, since a FiatTokenV2-style token
 * verifies `transferWithAuthorization` in its own code.
 *
 * The permit2 rails need a second, unrelated approval: Permit2 moves the token
 * with `permitTransferFrom`, which is an ordinary `transferFrom`, so the wallet
 * must have approved Permit2 as an ERC-20 spender.
 *
 * Neither is part of granting a session, and missing either one fails at
 * settlement rather than at signing. Permit2's callback is simply refused, and
 * the transfer reverts with no reason naming an approval: a merchant reports
 * `settlement failed: Execution reverted for an unknown reason`, which reads as
 * a problem with x402. qa lost a live run to exactly that and settled it with an
 * on-chain A/B on `approvedSignatureCheckers`
 * (`celo-harness/evidence/2026-09-29-x402-panel-purchase-live.md`).
 *
 * `checkX402Approvals` is that A/B, done before paying instead of after.
 */

import { type Address, type Hex, type PublicClient } from "viem";
import { networkByChainId, type NetworkConfig } from "./config.js";
import { buildPublicClient } from "./internal/relay.js";
import { getKey } from "./internal/account.js";
import { sessionKeyHash } from "./internal/erc1271.js";
import type { Session } from "./internal/sessions.js";
import {
  PERMIT2_ADDRESS,
  networkToChainId,
  resolveRail,
  type X402Requirement,
} from "./internal/x402Rails.js";

const ERC20_ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const CHECKERS_ABI = [
  {
    name: "approvedSignatureCheckers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

/** Every contract the account lets validate this key's ERC-1271 signatures. */
export async function approvedSignatureCheckers(
  publicClient: PublicClient,
  wallet: Address,
  keyHash: Hex,
): Promise<readonly Address[]> {
  return (await publicClient.readContract({
    address: wallet,
    abi: CHECKERS_ABI,
    functionName: "approvedSignatureCheckers",
    args: [keyHash],
    blockTag: "latest",
  })) as readonly Address[];
}

/**
 * Which contract verifies this rail's signature, and therefore which contract
 * has to be an approved checker. Permit2 for the permit2 rails; the token
 * itself for eip3009, because the token's own code calls back.
 */
export function x402SignatureChecker(req: X402Requirement): Address {
  return resolveRail(req) === "eip3009" ? (req.asset as Address) : PERMIT2_ADDRESS;
}

export type X402ApprovalStatus = {
  /** True when nothing is missing and a payment can settle. */
  ok: boolean;
  rail: "eip3009" | "permit2";
  token: Address;
  /** The contract that will call `isValidSignature` on the wallet. */
  checker: Address;
  keyHash: Hex;
  /** A super-admin key needs no checker approval; the account accepts it from anyone. */
  isSuperAdmin: boolean;
  /**
   * The ERC-20 allowance Permit2 needs, and what the wallet has. Absent on the
   * eip3009 rail, which moves the token from inside the token.
   */
  permit2Allowance?: { needed: bigint; actual: bigint; ok: boolean };
  /** Whether `checker` is approved for this key (or the key is super-admin). */
  checkerApproved: boolean;
  /** One sentence per missing approval, each naming the call that sets it. */
  missing: string[];
};

/**
 * Reads both approvals for a session and a payment requirement, before
 * anything is signed.
 *
 * A read, never a write: it tells the caller what to fix. `fetchWithX402` runs
 * it and refuses to pay when something is missing, because the alternative is a
 * settlement that reverts with no reason.
 */
export async function checkX402Approvals(
  session: Session,
  req: X402Requirement,
  opts: { network?: NetworkConfig; publicClient?: PublicClient } = {},
): Promise<X402ApprovalStatus> {
  const chainId = networkToChainId(req.network);
  const network = opts.network ?? networkByChainId(chainId);
  if (!network && !opts.publicClient) {
    throw new Error(
      `x402: cannot check approvals on chain ${chainId} — the SDK has no network config for it. ` +
        `Pass { network } or { publicClient }.`,
    );
  }
  const publicClient = opts.publicClient ?? buildPublicClient(network!);
  const wallet = session.walletAddress;
  const keyHash = sessionKeyHash(session);
  const rail = resolveRail(req);
  const token = req.asset as Address;
  const checker = x402SignatureChecker(req);
  const amount = BigInt(req.maxAmountRequired ?? req.amount ?? "0");

  // A key the account does not hold reads as not super-admin, and the missing
  // approval is then the least of the caller's problems; the session itself is
  // the thing to look at. Do not turn a revert here into a thrown error.
  const isSuperAdmin = await getKey(publicClient, wallet, keyHash)
    .then((k) => k.isSuperAdmin)
    .catch(() => false);

  const checkerApproved =
    isSuperAdmin ||
    (await approvedSignatureCheckers(publicClient, wallet, keyHash)).some(
      (c) => c.toLowerCase() === checker.toLowerCase(),
    );

  const permit2Allowance =
    rail === "permit2"
      ? await (async () => {
          const actual = (await publicClient.readContract({
            address: token,
            abi: ERC20_ALLOWANCE_ABI,
            functionName: "allowance",
            args: [wallet, PERMIT2_ADDRESS],
            blockTag: "latest",
          })) as bigint;
          return { needed: amount, actual, ok: actual >= amount };
        })()
      : undefined;

  const missing: string[] = [];
  if (permit2Allowance && !permit2Allowance.ok) {
    missing.push(
      `the wallet has not approved Permit2 to move ${token} (allowance ${permit2Allowance.actual}, ` +
        `needs ${permit2Allowance.needed}). Fix: approveTokenForPermit2(wallet, adminSigner, "${token}", { network }).`,
    );
  }
  if (!checkerApproved) {
    missing.push(
      `the account does not accept ${checker} as a signature checker for this session key ` +
        `(${keyHash}), so its ERC-1271 signature is refused: IthacaAccount.isValidSignature gates on ` +
        `msg.sender and only super-admin keys pass by default. Fix: ` +
        `approveSignatureChecker(wallet, adminSigner, { session, checker: "${checker}" }, { network }), ` +
        `or grant the session with x402Tokens so both approvals are set for you.`,
    );
  }

  return {
    ok: missing.length === 0,
    rail,
    token,
    checker,
    keyHash,
    isSuperAdmin,
    ...(permit2Allowance ? { permit2Allowance } : {}),
    checkerApproved,
    missing,
  };
}

/** The message `fetchWithX402` throws rather than paying into a revert. */
export function x402ApprovalError(status: X402ApprovalStatus, url?: string): Error {
  const where = url ? ` for ${url}` : "";
  return new Error(
    `x402: this session cannot pay${where} over the ${status.rail} rail yet, and settling anyway ` +
      `would revert with no reason. ${status.missing.length === 1 ? "One approval is" : `${status.missing.length} approvals are`} ` +
      `missing: ${status.missing.join(" Also, ")}`,
  );
}
