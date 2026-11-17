/**
 * The two approvals an x402 payment needs from a session key, and the guard
 * that reads them before paying.
 *
 * Why this exists: missing either approval fails at **settlement**, not at
 * signing, and the revert names neither. A merchant reports
 * `settlement failed: Execution reverted for an unknown reason`, which reads as
 * a problem with x402. qa lost a live run to that and settled it with an
 * on-chain A/B on `approvedSignatureCheckers`
 * (`celo-harness/evidence/2026-10-05-...`). These tests are that A/B, done
 * before paying.
 *
 * The chain is injected, so they run offline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { maxUint256, type Address, type Hex, type PublicClient } from "viem";
import {
  checkX402Approvals,
  x402ApprovalError,
  x402SignatureChecker,
} from "./x402Approvals.js";
import { fetchWithX402 } from "./x402.js";
import { PERMIT2_ADDRESS, type X402Requirement } from "./internal/x402Rails.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { sessionKeyHash } from "./internal/erc1271.js";
import type { Session } from "./internal/sessions.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";

function makeSession(): Session {
  const signer = createPrivateKeySigner();
  return { walletAddress: WALLET, signer, publicKey: signer.publicKey, permissions: {}, expiry: 0 };
}

const permit2Req: X402Requirement = {
  scheme: "exact",
  network: "eip155:11142220",
  asset: USDC,
  payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  amount: "10000",
  maxTimeoutSeconds: 300,
  // A real challenge names the settler bound as the Permit2 spender.
  extra: {
    name: "USDC",
    version: "2",
    assetTransferMethod: "permit2-exact",
    spenderAddress: "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633",
  },
};

const eip3009Req: X402Requirement = {
  ...permit2Req,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
};

/** A read-only account + token: which checkers a key has, and the allowance. */
function fakeChain(o: {
  checkers?: readonly Address[];
  allowance?: bigint;
  isSuperAdmin?: boolean;
  keyMissing?: boolean;
}): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getKey":
          if (o.keyMissing) throw new Error("execution reverted: KeyDoesNotExist");
          return { expiry: 0, keyType: 1, isSuperAdmin: o.isSuperAdmin ?? false, publicKey: "0x" };
        case "approvedSignatureCheckers":
          return o.checkers ?? [];
        case "allowance":
          return o.allowance ?? 0n;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

describe("x402SignatureChecker", () => {
  // The account gates isValidSignature on msg.sender, so the contract that has
  // to be approved is whoever calls back — and that differs by rail.
  test("Permit2 on the permit2 rail, the token itself on eip3009", () => {
    expect(x402SignatureChecker(permit2Req)).toBe(PERMIT2_ADDRESS);
    expect(x402SignatureChecker(eip3009Req)).toBe(USDC);
  });
});

describe("checkX402Approvals: the permit2 rail needs both", () => {
  test("both present: ok, and nothing to report", async () => {
    const session = makeSession();
    const status = await checkX402Approvals(session, permit2Req, {
      publicClient: fakeChain({ checkers: [PERMIT2_ADDRESS], allowance: maxUint256 }),
    });
    expect(status.ok).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.rail).toBe("permit2");
    expect(status.checker).toBe(PERMIT2_ADDRESS);
    expect(status.keyHash).toBe(sessionKeyHash(session));
    expect(status.permit2Allowance).toEqual({ needed: 10000n, actual: maxUint256, ok: true });
  });

  // qa's case exactly: the token was approved to Permit2, the checker was not,
  // and the payment reverted with no reason naming either.
  test("token approved but the checker is not: names the checker, the key and the fix", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ checkers: [], allowance: maxUint256 }),
    });
    expect(status.ok).toBe(false);
    expect(status.checkerApproved).toBe(false);
    expect(status.missing).toHaveLength(1);
    const [m] = status.missing;
    expect(m).toContain(PERMIT2_ADDRESS);
    expect(m).toContain(status.keyHash);
    expect(m).toContain("approveSignatureChecker");
    expect(m).toContain("x402Tokens");
    // The mechanism, so the reader knows why rather than only what to run.
    expect(m).toContain("msg.sender");
  });

  test("checker approved but the token is not: names the allowance and the fix", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ checkers: [PERMIT2_ADDRESS], allowance: 0n }),
    });
    expect(status.ok).toBe(false);
    expect(status.permit2Allowance?.ok).toBe(false);
    expect(status.missing).toHaveLength(1);
    expect(status.missing[0]).toContain("approveTokenForPermit2");
    expect(status.missing[0]).toContain(USDC);
  });

  test("neither: both are reported, not just the first", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ checkers: [], allowance: 0n }),
    });
    expect(status.missing).toHaveLength(2);
    expect(x402ApprovalError(status).message).toContain("2 approvals are missing");
  });

  // An allowance that exists but is smaller than this payment is not an
  // approval: Permit2's transferFrom would fail on it.
  test("an allowance below the amount counts as missing", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ checkers: [PERMIT2_ADDRESS], allowance: 9999n }),
    });
    expect(status.permit2Allowance).toEqual({ needed: 10000n, actual: 9999n, ok: false });
    expect(status.ok).toBe(false);
  });

  test("an allowance exactly equal to the amount is enough", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ checkers: [PERMIT2_ADDRESS], allowance: 10000n }),
    });
    expect(status.ok).toBe(true);
  });

  test("the checker match ignores case, since addresses arrive either way", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({
        checkers: [PERMIT2_ADDRESS.toLowerCase() as Address],
        allowance: maxUint256,
      }),
    });
    expect(status.checkerApproved).toBe(true);
  });
});

describe("checkX402Approvals: the eip3009 rail", () => {
  // The token moves itself, so there is no Permit2 allowance to have — and
  // reporting one as missing would send the caller to fix the wrong thing.
  test("needs the token as checker and no allowance at all", async () => {
    const status = await checkX402Approvals(makeSession(), eip3009Req, {
      publicClient: fakeChain({ checkers: [USDC] }),
    });
    expect(status.rail).toBe("eip3009");
    expect(status.checker).toBe(USDC);
    expect(status.permit2Allowance).toBeUndefined();
    expect(status.ok).toBe(true);
  });

  test("Permit2 approved instead of the token does not help here", async () => {
    const status = await checkX402Approvals(makeSession(), eip3009Req, {
      publicClient: fakeChain({ checkers: [PERMIT2_ADDRESS] }),
    });
    expect(status.ok).toBe(false);
    expect(status.missing[0]).toContain(USDC);
  });
});

describe("checkX402Approvals: a super-admin key", () => {
  // `isValidSignature` passes a super-admin key from any caller, which is why
  // an admin-signed payment works with nothing set up. Reporting a missing
  // checker for one would be a false alarm.
  test("needs no checker approval, and none is reported", async () => {
    const status = await checkX402Approvals(makeSession(), eip3009Req, {
      publicClient: fakeChain({ checkers: [], isSuperAdmin: true }),
    });
    expect(status.isSuperAdmin).toBe(true);
    expect(status.checkerApproved).toBe(true);
    expect(status.ok).toBe(true);
  });

  test("but it still needs the Permit2 allowance on the permit2 rail", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ checkers: [], isSuperAdmin: true, allowance: 0n }),
    });
    expect(status.checkerApproved).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.missing[0]).toContain("approveTokenForPermit2");
  });
});

describe("checkX402Approvals: edges", () => {
  // A key the account does not hold reads as not super-admin rather than
  // throwing: the missing approval is then the least of the caller's problems,
  // and the session itself is the thing to look at.
  test("a key the account does not hold does not make the read throw", async () => {
    const status = await checkX402Approvals(makeSession(), permit2Req, {
      publicClient: fakeChain({ keyMissing: true, checkers: [], allowance: 0n }),
    });
    expect(status.isSuperAdmin).toBe(false);
    expect(status.ok).toBe(false);
  });

  test("a chain the SDK has no config for says so, rather than guessing an RPC", async () => {
    await expect(
      checkX402Approvals(makeSession(), { ...permit2Req, network: "eip155:999999" }),
    ).rejects.toThrow(/no network config for it/);
  });

  test("the error names the rail and says settling anyway would revert", () => {
    const message = x402ApprovalError(
      {
        ok: false,
        rail: "permit2",
        token: USDC,
        checker: PERMIT2_ADDRESS,
        keyHash: `0x${"11".repeat(32)}` as Hex,
        isSuperAdmin: false,
        checkerApproved: false,
        missing: ["one thing"],
      },
      "https://api.example.com/paid",
    ).message;
    expect(message).toContain("permit2 rail");
    expect(message).toContain("https://api.example.com/paid");
    expect(message).toContain("revert with no reason");
    expect(message).toContain("One approval is");
  });
});

/**
 * The guard at the payment boundary. Two properties matter and they pull in
 * opposite directions: it must refuse a payment it knows would revert, and it
 * must not refuse one it merely could not check. A guard that turns an
 * unreachable RPC into a failed payment is worse than the problem it guards.
 */
describe("fetchWithX402 runs the guard before paying", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A merchant that answers 402 once, then 200, counting payment attempts. */
  function merchant() {
    const paid: string[] = [];
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("X-PAYMENT");
      if (!header) {
        return new Response(
          JSON.stringify({ x402Version: 2, accepts: [permit2Req] }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      paid.push(header);
      return new Response("paid", { status: 200 });
    }) as typeof fetch;
    return { attempts: () => paid.length };
  }

  test("a missing approval stops the payment, and nothing is signed or sent", async () => {
    const m = merchant();
    const thrown = await fetchWithX402(makeSession(), "https://api.example.com/paid", undefined, {
      publicClient: fakeChain({ checkers: [], allowance: 0n }),
    }).then(
      () => undefined,
      (e: Error) => e.message,
    );
    expect(thrown).toContain("cannot pay");
    expect(thrown).toContain("approveSignatureChecker");
    expect(m.attempts()).toBe(0);
  });

  test("both approvals present: it pays", async () => {
    const m = merchant();
    const res = await fetchWithX402(makeSession(), "https://api.example.com/paid", undefined, {
      publicClient: fakeChain({ checkers: [PERMIT2_ADDRESS], allowance: maxUint256 }),
    });
    expect(res.status).toBe(200);
    expect(m.attempts()).toBe(1);
  });

  // The read failing is not evidence of a missing approval, so it must not be
  // treated as one. An RPC that is down, or a chain the SDK has no config for,
  // leaves the caller exactly where they were before the guard existed.
  test("a read that fails leaves the payment alone", async () => {
    const m = merchant();
    const broken = {
      readContract: async () => {
        throw new Error("HTTP request failed");
      },
    } as unknown as PublicClient;
    const res = await fetchWithX402(makeSession(), "https://api.example.com/paid", undefined, {
      publicClient: broken,
    });
    expect(res.status).toBe(200);
    expect(m.attempts()).toBe(1);
  });

  test("checkApprovals: false skips the reads entirely", async () => {
    const m = merchant();
    let reads = 0;
    const counting = {
      readContract: async () => {
        reads += 1;
        return [];
      },
    } as unknown as PublicClient;
    const res = await fetchWithX402(makeSession(), "https://api.example.com/paid", undefined, {
      checkApprovals: false,
      publicClient: counting,
    });
    expect(res.status).toBe(200);
    expect(m.attempts()).toBe(1);
    expect(reads).toBe(0);
  });
});
