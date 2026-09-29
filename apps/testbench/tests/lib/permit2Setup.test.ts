import { describe, expect, test } from "vitest";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeAccountSecp256k1KeyHash } from "../../../../packages/wallet/src/internal/erc1271";
import { accountKeyHashForAddress, missingSteps, readiness } from "../../src/lib/permit2Setup";

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const OTHER = "0x1111111111111111111111111111111111111111" as const;
const KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

describe("accountKeyHashForAddress", () => {
  test("matches the SDK's own derivation, so the two cannot drift apart", () => {
    // The bench cannot import the SDK's internal module at runtime, so this
    // test is what keeps the copy honest.
    const address = privateKeyToAccount(KEY).address;
    expect(accountKeyHashForAddress(address)).toBe(computeAccountSecp256k1KeyHash(address));
  });

  test("is not the KeyStore's key id, which is the easy mistake", () => {
    // The KeyStore and the Celo cache hash keccak256(publicKey); the account
    // hashes the wrapped (keyType, keccak256(paddedAddress)) form. Querying
    // approvedSignatureCheckers with the wrong one answers empty rather than
    // erroring, which would read as "no approval" forever.
    const account = privateKeyToAccount(KEY);
    expect(accountKeyHashForAddress(account.address)).not.toBe(keccak256(account.publicKey));
  });

  test("is case-insensitive about the address", () => {
    const address = privateKeyToAccount(KEY).address;
    expect(accountKeyHashForAddress(address.toLowerCase() as typeof address)).toBe(
      accountKeyHashForAddress(address),
    );
  });
});

describe("readiness", () => {
  test("both approvals present is the only ready state", () => {
    expect(readiness({ tokenAllowance: 1n, checkers: [PERMIT2], permit2: PERMIT2 }).ready).toBe(true);
  });

  test("the token alone is not ready, which is the state that used to look ready", () => {
    const r = readiness({ tokenAllowance: 2n ** 256n - 1n, checkers: [], permit2: PERMIT2 });
    expect(r).toMatchObject({ tokenApproved: true, checkerApproved: false, ready: false });
    expect(missingSteps(r)).toHaveLength(1);
    expect(missingSteps(r)[0]).toContain("refuses its callback");
  });

  test("the checker alone is not ready either", () => {
    const r = readiness({ tokenAllowance: 0n, checkers: [PERMIT2], permit2: PERMIT2 });
    expect(r).toMatchObject({ tokenApproved: false, checkerApproved: true, ready: false });
    expect(missingSteps(r)[0]).toContain("cannot pull the payment");
  });

  test("neither present names both", () => {
    expect(missingSteps(readiness({ tokenAllowance: 0n, checkers: [], permit2: PERMIT2 }))).toHaveLength(2);
  });

  test("some other approved checker is not Permit2", () => {
    expect(readiness({ tokenAllowance: 1n, checkers: [OTHER], permit2: PERMIT2 }).checkerApproved).toBe(false);
  });

  test("the checker list is matched case-insensitively, as addresses are", () => {
    const lower = PERMIT2.toLowerCase() as typeof PERMIT2;
    expect(readiness({ tokenAllowance: 1n, checkers: [lower], permit2: PERMIT2 }).checkerApproved).toBe(true);
  });

  test("nothing missing says nothing", () => {
    expect(missingSteps(readiness({ tokenAllowance: 1n, checkers: [PERMIT2], permit2: PERMIT2 }))).toEqual([]);
  });
});
