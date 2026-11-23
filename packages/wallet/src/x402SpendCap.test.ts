import { test, expect, afterEach, describe } from "bun:test";
import type { Address, PublicClient } from "viem";
import { AltanaError } from "./errors.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import type { Session, SpendPermission } from "./internal/sessions.js";
import { fetchWithX402, type X402Requirement } from "./x402.js";
import {
  checkX402SpendCap,
  resetX402SpendTally,
  startOfSpendPeriod,
} from "./x402SpendCap.js";

/**
 * The session's spend cap, applied to x402 payments before signing (issue
 * #164). The approval guard has its own tests and is switched off here so a
 * test reads only what it is about.
 */
const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const OTHER: Address = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const PAYTO: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const URL = "https://api.example.com/paid";
// A Monday noon UTC, so no test sits on a period boundary.
const NOON = 1795435200 + 12 * 3600;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetX402SpendTally();
});

function makeSession(spend?: SpendPermission[]): Session {
  const signer = createPrivateKeySigner();
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: spend ? { spend } : {},
    expiry: 0,
  };
}

function requirement(amount: bigint, asset: Address = USDC): X402Requirement {
  return {
    scheme: "exact",
    network: "eip155:11142220",
    asset,
    amount: amount.toString(),
    payTo: PAYTO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  } as X402Requirement;
}

type SpendInfo = { token: Address; period: number; currentSpent: bigint; current: bigint };

/** The chain, as far as this check reads it. `reads` counts every call. */
function fakeChain(o: { infos?: SpendInfo[]; unreadable?: boolean; reads?: string[] } = {}): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      o.reads?.push(functionName);
      if (o.unreadable) throw new Error("rpc down");
      switch (functionName) {
        case "spendInfos":
          return (o.infos ?? []).map((i) => ({ ...i, limit: 0n, spent: 0n, lastUpdated: 0n }));
        case "symbol":
          return "USDC";
        case "decimals":
          return 6;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

/** A seller asking `amount`; records each request's X-PAYMENT header. */
function seller(amount: bigint, asset: Address = USDC) {
  const paid: string[] = [];
  let requests = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests += 1;
    const header = new Headers(init?.headers).get("X-PAYMENT");
    if (!header) {
      return new Response(JSON.stringify({ x402Version: 2, accepts: [requirement(amount, asset)] }), { status: 402 });
    }
    paid.push(header);
    return new Response("paid", { status: 200 });
  }) as typeof fetch;
  return { paid, requests: () => requests };
}

const pay = (session: Session, chain: PublicClient, extra: Record<string, unknown> = {}) =>
  fetchWithX402(session, URL, undefined, { checkApprovals: false, publicClient: chain, ...extra });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as AltanaError,
  );

describe("a session with no cap on the token pays as it always has", () => {
  test("no permissions at all: paid, and the chain is not read", async () => {
    const reads: string[] = [];
    const shop = seller(10_000n);
    const res = await pay(makeSession(), fakeChain({ reads }));
    expect(res.status).toBe(200);
    expect(shop.paid).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  test("a native-only cap does not bound a token payment", async () => {
    const shop = seller(10_000n);
    const res = await pay(makeSession([{ limit: 1n, period: "day" }]), fakeChain());
    expect(res.status).toBe(200);
    expect(shop.paid).toHaveLength(1);
  });

  test("a cap on another token does not bound this one", async () => {
    const shop = seller(10_000n);
    const res = await pay(makeSession([{ token: OTHER, limit: 1n, period: "day" }]), fakeChain());
    expect(res.status).toBe(200);
    expect(shop.paid).toHaveLength(1);
  });
});

describe("a session with a cap on the token", () => {
  const cap = (limit: bigint): SpendPermission[] => [{ token: USDC, limit, period: "day" }];

  test("a payment over the cap is refused and nothing is signed or sent", async () => {
    const shop = seller(10_000n);
    const err = await refusal(pay(makeSession(cap(5_000n)), fakeChain()));
    expect(err?.code).toBe("spend_limit_exceeded");
    expect(err?.message).toContain("asks 0.01 USDC");
    expect(err?.message).toContain("0.005 USDC of the 0.005 USDC daily limit is left");
    expect(err?.message).toContain("Grant a new session key with a higher limit");
    expect(shop.paid).toHaveLength(0);
    // Only the unpaid request that drew the 402 went out.
    expect(shop.requests()).toBe(1);
  });

  test("a payment equal to the cap is paid", async () => {
    const shop = seller(5_000n);
    const res = await pay(makeSession(cap(5_000n)), fakeChain());
    expect(res.status).toBe(200);
    expect(shop.paid).toHaveLength(1);
  });

  test("payments add up: the one that would pass the cap is refused", async () => {
    const shop = seller(2_000n);
    const session = makeSession(cap(5_000n));
    expect((await pay(session, fakeChain())).status).toBe(200);
    expect((await pay(session, fakeChain())).status).toBe(200);
    const err = await refusal(pay(session, fakeChain()));
    expect(err?.code).toBe("spend_limit_exceeded");
    expect(err?.message).toContain("0.001 USDC of the 0.005 USDC daily limit is left");
    expect(shop.paid).toHaveLength(2);
  });

  test("a refused payment is not counted", async () => {
    const session = makeSession(cap(5_000n));
    seller(10_000n);
    expect((await refusal(pay(session, fakeChain())))?.code).toBe("spend_limit_exceeded");
    const shop = seller(5_000n);
    expect((await pay(session, fakeChain())).status).toBe(200);
    expect(shop.paid).toHaveLength(1);
  });

  test("two payments started together cannot both use the same remainder", async () => {
    const shop = seller(3_000n);
    const session = makeSession(cap(5_000n));
    const results = await Promise.allSettled([pay(session, fakeChain()), pay(session, fakeChain())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(shop.paid).toHaveLength(1);
  });

  test("another session of the same wallet has its own count", async () => {
    seller(5_000n);
    expect((await pay(makeSession(cap(5_000n)), fakeChain())).status).toBe(200);
    expect((await pay(makeSession(cap(5_000n)), fakeChain())).status).toBe(200);
  });

  test("the token is matched whatever its letter case", async () => {
    seller(10_000n, USDC.toLowerCase() as Address);
    const session = makeSession([{ token: USDC.toUpperCase().replace("0X", "0x") as Address, limit: 5_000n, period: "day" }]);
    expect((await refusal(pay(session, fakeChain())))?.code).toBe("spend_limit_exceeded");
  });

  test("every cap on the token applies: a roomy daily cap does not excuse a tight hourly one", async () => {
    seller(2_000n);
    const session = makeSession([
      { token: USDC, limit: 100_000n, period: "day" },
      { token: USDC, limit: 1_000n, period: "hour" },
    ]);
    const err = await refusal(pay(session, fakeChain()));
    expect(err?.code).toBe("spend_limit_exceeded");
    expect(err?.message).toContain("hourly limit");
  });

  test("checkSpendCap: false skips the check", async () => {
    const shop = seller(10_000n);
    const res = await pay(makeSession(cap(5_000n)), fakeChain(), { checkSpendCap: false });
    expect(res.status).toBe(200);
    expect(shop.paid).toHaveLength(1);
  });
});

describe("what the account already recorded for the key", () => {
  const session = () => makeSession([{ token: USDC, limit: 5_000n, period: "day" }]);
  const today = BigInt(startOfSpendPeriod(NOON, "day"));

  test("spending through execute in the current period counts against the cap", async () => {
    const status = await checkX402SpendCap(session(), requirement(2_000n), {
      now: NOON,
      publicClient: fakeChain({ infos: [{ token: USDC, period: 2, currentSpent: 4_000n, current: today }] }),
    });
    expect(status.ok).toBe(false);
    expect(status.caps[0]).toMatchObject({ spentOnChain: 4_000n, spentX402: 0n, remaining: 1_000n, ok: false });
  });

  test("a figure for an earlier period is not counted", async () => {
    const status = await checkX402SpendCap(session(), requirement(2_000n), {
      now: NOON,
      publicClient: fakeChain({ infos: [{ token: USDC, period: 2, currentSpent: 4_000n, current: today - 86_400n }] }),
    });
    expect(status.ok).toBe(true);
    expect(status.caps[0]?.spentOnChain).toBe(0n);
  });

  test("another token's or another period's record is not counted", async () => {
    const status = await checkX402SpendCap(session(), requirement(2_000n), {
      now: NOON,
      publicClient: fakeChain({
        infos: [
          { token: OTHER, period: 2, currentSpent: 4_000n, current: today },
          { token: USDC, period: 1, currentSpent: 4_000n, current: BigInt(startOfSpendPeriod(NOON, "hour")) },
        ],
      }),
    });
    expect(status.ok).toBe(true);
  });

  test("an unreadable chain still applies the cap", async () => {
    const chain = fakeChain({ unreadable: true });
    expect((await checkX402SpendCap(session(), requirement(2_000n), { publicClient: chain })).ok).toBe(true);
    const status = await checkX402SpendCap(session(), requirement(10_000n), { publicClient: chain });
    expect(status.ok).toBe(false);

    seller(10_000n);
    const err = await refusal(pay(session(), chain));
    expect(err?.code).toBe("spend_limit_exceeded");
    // With no symbol to read, the amounts are still stated, in base units.
    expect(err?.message).toContain("10000 base units");
  });

  test("the check itself counts nothing", async () => {
    const s = session();
    await checkX402SpendCap(s, requirement(5_000n), { publicClient: fakeChain() });
    const again = await checkX402SpendCap(s, requirement(5_000n), { publicClient: fakeChain() });
    expect(again.ok).toBe(true);
    expect(again.caps[0]?.spentX402).toBe(0n);
  });
});

describe("periods are the account's fixed periods, not rolling windows", () => {
  // startOfSpendPeriod(1795000000, p) read from an account on Celo Sepolia,
  // 2026-11-23.
  const FROM_CHAIN: [SpendPermission["period"], number][] = [
    ["minute", 1794999960],
    ["hour", 1794999600],
    ["day", 1794960000],
    ["week", 1794787200],
    ["month", 1793491200],
    ["year", 1767225600],
  ];
  for (const [period, start] of FROM_CHAIN) {
    test(`${period} starts where the contract says`, () => {
      expect(startOfSpendPeriod(1795000000, period)).toBe(start);
    });
  }

  test("a new period starts the count again", async () => {
    const s = makeSession([{ token: USDC, limit: 5_000n, period: "day" }]);
    const chain = fakeChain();
    const realNow = Date.now;
    try {
      Date.now = () => NOON * 1000;
      seller(5_000n);
      expect((await pay(s, chain)).status).toBe(200);
      expect((await refusal(pay(s, chain)))?.code).toBe("spend_limit_exceeded");
      Date.now = () => (NOON + 86_400) * 1000;
      expect((await pay(s, chain)).status).toBe(200);
    } finally {
      Date.now = realNow;
    }
  });
});

test("the refusal is an AltanaError a caller can branch on", async () => {
  seller(10_000n);
  const err = await refusal(pay(makeSession([{ token: USDC, limit: 5_000n, period: "day" }]), fakeChain()));
  expect(err).toBeInstanceOf(AltanaError);
  expect(err?.message).toContain(URL);
  expect(err?.message).not.toContain("\n");
});

test("an expired session is refused before anything is signed, in the sentence execute uses", async () => {
  const shop = seller(10_000n);
  const session = { ...makeSession(), expiry: Math.floor(Date.now() / 1000) - 60 };
  const err = await refusal(pay(session, fakeChain()));
  expect(err?.code).toBe("session_expired");
  expect(shop.paid).toHaveLength(0);
});

test("a session that never expires (expiry 0) is not treated as expired", async () => {
  const shop = seller(10_000n);
  expect((await pay(makeSession(), fakeChain())).status).toBe(200);
  expect(shop.paid).toHaveLength(1);
});
