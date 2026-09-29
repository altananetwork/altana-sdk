/**
 * What the Permit2 x402 rail needs from a wallet, which is **two** approvals,
 * not one. Missing either makes settlement revert with no reason that mentions
 * approvals at all.
 *
 * 1. **The token approved to Permit2.** Permit2 pulls the payment with
 *    `permitWitnessTransferFrom`, so it needs an ordinary ERC-20 allowance.
 * 2. **Permit2 approved as a signature checker for that session key.**
 *    `IthacaAccount.isValidSignature` gates on `msg.sender`: only super-admin
 *    keys pass by default, so when Permit2 calls back to verify the session
 *    key's ERC-1271 signature it is refused, and the transfer reverts.
 *
 * qa proved the second one by A/B on live Celo Sepolia: same rail, same seller,
 * same token, two wallets, and the only difference was Permit2's presence in
 * `approvedSignatureCheckers(keyHash)` for the session key. The one that had it
 * settled; the one that did not reverted with
 * "Execution reverted for an unknown reason".
 */

import { encodeAbiParameters, keccak256, padHex, type Address, type Hex } from "viem";

/** `approvedSignatureCheckers(bytes32) returns (address[])` on IthacaAccount. */
export const APPROVED_CHECKERS_ABI = [
  {
    name: "approvedSignatureCheckers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

/**
 * The keyHash `IthacaAccount` stores for a secp256k1 key:
 * `keccak256(abi.encode(uint256(2), keccak256(abi.encode(address))))`, where 2
 * is the Secp256k1 member of the KeyType enum and the stored public key is the
 * 20-byte address left-padded to 32.
 *
 * **This is not the KeyStore's key id.** The KeyStore and the Celo cache hash
 * `keccak256(publicKey)`; the account hashes the wrapped form above. Querying
 * one with the other returns an empty answer rather than an error, so the two
 * must not be mixed up. Mirrors `computeAccountSecp256k1KeyHash` in the SDK,
 * which is internal; `tests/lib/permit2Setup.test.ts` pins the two together.
 */
export function accountKeyHashForAddress(address: Address): Hex {
  const publicKeyHash = keccak256(padHex(address, { size: 32 }));
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, publicKeyHash]),
  );
}

export type Permit2Readiness = {
  /** The ERC-20 allowance the wallet has given Permit2. */
  tokenAllowance: bigint;
  /** Every contract approved to check this session key's signatures. */
  checkers: readonly Address[];
  tokenApproved: boolean;
  checkerApproved: boolean;
  /** Both, which is the only state in which a Permit2 payment can settle. */
  ready: boolean;
};

export function readiness(args: {
  tokenAllowance: bigint;
  checkers: readonly Address[];
  permit2: Address;
}): Permit2Readiness {
  const tokenApproved = args.tokenAllowance > 0n;
  const checkerApproved = args.checkers.some(
    (c) => c.toLowerCase() === args.permit2.toLowerCase(),
  );
  return {
    tokenAllowance: args.tokenAllowance,
    checkers: args.checkers,
    tokenApproved,
    checkerApproved,
    ready: tokenApproved && checkerApproved,
  };
}

/** What is still missing, in the operator's terms. Empty when nothing is. */
export function missingSteps(r: Permit2Readiness): string[] {
  const out: string[] = [];
  if (!r.tokenApproved) out.push("the token is not approved to Permit2, so it cannot pull the payment");
  if (!r.checkerApproved) {
    out.push(
      "Permit2 is not approved to check this session key's signatures, so the account refuses its " +
        "callback and settlement reverts without saying why",
    );
  }
  return out;
}
