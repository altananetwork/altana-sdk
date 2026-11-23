/**
 * The session's spend cap, applied to x402 payments before they are signed.
 *
 * The account enforces a session's spend caps where it can see a spend: inside
 * `execute`. An x402 payment is not one. The session signs an authorization
 * and somebody else moves the token with it (Permit2, or the token's own
 * `transferWithAuthorization`), and the only question the account is asked is
 * whether the signature is from a key it accepts. No amount reaches it, so no
 * cap is checked: a session capped at 0.005 USDC a day paid 0.02 USDC through
 * x402 on Celo Sepolia (2026-11-23, issue #164), while the same session was
 * refused a 0.01 USDC transfer through `execute`.
 *
 * The SDK is the one signing, so it is the one place that can ask first. For
 * each cap the session holds on the token the seller asks for, a payment is
 * refused when its amount, plus what the session already spent in the cap's
 * current period, is over the limit. A session with no cap on that token pays
 * as it always has: no cap was asked for, so there is none to apply.
 *
 * What counts as already spent:
 *
 * - what the account recorded for this key in the current period, read from
 *   `spendInfos`. That is the session's spending through `execute`.
 * - what this process has signed for x402 in the current period. The account
 *   never sees those, so nothing on chain counts them, and the count lives
 *   here, in memory. It starts again at zero when the process does.
 *
 * Periods are the account's own: fixed and aligned to the clock in UTC (a day
 * starts at 00:00, a week on Monday, a month on the 1st), not a window that
 * rolls with each payment. `startOfSpendPeriod` mirrors the contract's, and
 * its unit test holds six values read from the account on Celo Sepolia.
 *
 * This is a check in the signer, not a rule of the account. Whoever holds the
 * session key and signs without this SDK is not bound by it.
 */
import { erc20Abi, formatUnits, type Address, type Hex, type PublicClient } from "viem";
import { networkByChainId, type NetworkConfig } from "./config.js";
import { AltanaError } from "./errors.js";
import { buildPublicClient } from "./internal/relay.js";
import { sessionKeyHash } from "./internal/erc1271.js";
import type { Session, SpendPermission } from "./internal/sessions.js";
import { networkToChainId } from "./internal/x402Rails.js";
import type { X402Requirement } from "./x402.js";

type Period = SpendPermission["period"];

/** `GuardedExecutor.SpendPeriod`, in the contract's order. */
const PERIOD_INDEX: Record<Period, number> = { minute: 0, hour: 1, day: 2, week: 3, month: 4, year: 5 };

const SPEND_INFOS_ABI = [
  {
    type: "function",
    name: "spendInfos",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [
      {
        name: "results",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "period", type: "uint8" },
          { name: "limit", type: "uint256" },
          { name: "spent", type: "uint256" },
          { name: "lastUpdated", type: "uint256" },
          { name: "currentSpent", type: "uint256" },
          { name: "current", type: "uint256" },
        ],
      },
    ],
  },
] as const;

/**
 * The start of the period holding `unixSeconds`, as the account computes it:
 * fixed periods on the UTC clock, a week starting on Monday.
 */
export function startOfSpendPeriod(unixSeconds: number, period: Period): number {
  const t = Math.floor(unixSeconds);
  switch (period) {
    case "minute":
      return t - (t % 60);
    case "hour":
      return t - (t % 3600);
    case "day":
      return t - (t % 86400);
    case "week": {
      // 1970-01-01 was a Thursday, so day 0 is three days into its week.
      const days = Math.floor(t / 86400);
      return (days - ((days + 3) % 7)) * 86400;
    }
    case "month": {
      const d = new Date(t * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    }
    case "year":
      return Date.UTC(new Date(t * 1000).getUTCFullYear(), 0, 1) / 1000;
  }
}

/** One of the session's caps on the token, against one payment. */
export type X402SpendCapReading = {
  period: Period;
  limit: bigint;
  /** Unix seconds the cap's current period started. */
  periodStart: number;
  /** What the account recorded for this key in the period (through `execute`); 0 when it could not be read. */
  spentOnChain: bigint;
  /** What this process has signed for x402 in the period. */
  spentX402: bigint;
  /** What is left of the limit before this payment. */
  remaining: bigint;
  /** Whether the payment fits in what is left. */
  ok: boolean;
};

export type X402SpendCapStatus = {
  /** True when the payment fits every cap the session holds on the token, or it holds none. */
  ok: boolean;
  token: Address;
  amount: bigint;
  /** One per cap on the token. Empty when the session has none, which is not a refusal. */
  caps: X402SpendCapReading[];
};

export type X402SpendCapOptions = {
  network?: NetworkConfig;
  publicClient?: PublicClient;
  /** Unix seconds; defaults to the clock. For tests. */
  now?: number;
};

// What this process has signed for x402, per wallet, key, token, period and
// period start. A new period is a new key, so an old one is never read again.
const signed = new Map<string, bigint>();

function tallyKey(session: Session, token: Address, period: Period, periodStart: number): string {
  return [session.walletAddress, session.publicKey, token, period, periodStart].join("|").toLowerCase();
}

/** Forgets every x402 payment this process counted. For tests. */
export function resetX402SpendTally(): void {
  signed.clear();
}

function capsOn(session: Session, token: Address): SpendPermission[] {
  return (session.permissions?.spend ?? []).filter(
    (cap) => cap.token !== undefined && cap.token.toLowerCase() === token.toLowerCase(),
  );
}

function amountOf(req: X402Requirement): bigint {
  return BigInt(req.maxAmountRequired ?? req.amount ?? "0");
}

function clientFor(req: X402Requirement, opts: X402SpendCapOptions): PublicClient | undefined {
  if (opts.publicClient) return opts.publicClient;
  try {
    const network = opts.network ?? networkByChainId(networkToChainId(req.network));
    return network ? buildPublicClient(network) : undefined;
  } catch {
    return undefined;
  }
}

/** What the account recorded for this key, or nothing when it cannot be read. */
async function readSpendInfos(session: Session, client: PublicClient | undefined) {
  if (!client) return [];
  try {
    return await client.readContract({
      address: session.walletAddress,
      abi: SPEND_INFOS_ABI,
      functionName: "spendInfos",
      args: [sessionKeyHash(session) as Hex],
      blockTag: "latest",
    });
  } catch {
    // Unreadable is not a refusal and not a pass: the cap and this process's
    // own count are still applied below, with nothing added from the chain.
    return [];
  }
}

type SpendInfo = Awaited<ReturnType<typeof readSpendInfos>>[number];

function evaluate(
  session: Session,
  token: Address,
  amount: bigint,
  caps: readonly SpendPermission[],
  infos: readonly SpendInfo[],
  now: number,
): X402SpendCapStatus {
  const readings = caps.map((cap): X402SpendCapReading => {
    const periodStart = startOfSpendPeriod(now, cap.period);
    const info = infos.find(
      (i) => i.token.toLowerCase() === token.toLowerCase() && Number(i.period) === PERIOD_INDEX[cap.period],
    );
    // The account's figure is for the period it considers current. Count it
    // only when that is the period this payment falls in.
    const spentOnChain = info && Number(info.current) === periodStart ? info.currentSpent : 0n;
    const spentX402 = signed.get(tallyKey(session, token, cap.period, periodStart)) ?? 0n;
    const used = spentOnChain + spentX402;
    const remaining = cap.limit > used ? cap.limit - used : 0n;
    return { period: cap.period, limit: cap.limit, periodStart, spentOnChain, spentX402, remaining, ok: amount <= remaining };
  });
  return { ok: readings.every((r) => r.ok), token, amount, caps: readings };
}

/**
 * Reads a payment against the session's spend caps on its token, before
 * anything is signed. A read: it changes nothing and counts nothing.
 *
 * `fetchWithX402` runs this and refuses a payment that does not fit. Call it
 * yourself when you sign with `signX402Payment`, which does not.
 */
export async function checkX402SpendCap(
  session: Session,
  req: X402Requirement,
  opts: X402SpendCapOptions = {},
): Promise<X402SpendCapStatus> {
  const token = req.asset as Address;
  const amount = amountOf(req);
  const caps = capsOn(session, token);
  if (caps.length === 0) return { ok: true, token, amount, caps: [] };
  const infos = await readSpendInfos(session, clientFor(req, opts));
  return evaluate(session, token, amount, caps, infos, opts.now ?? Date.now() / 1000);
}

/**
 * The check and the count as one step, for `fetchWithX402`.
 *
 * Refuses a payment that does not fit, and otherwise counts it at once, so two
 * payments started together cannot both be measured against the same
 * remainder. `release` gives the amount back when nothing was signed.
 *
 * A payment that was signed stays counted whatever the seller answers. The
 * authorization is out of this process's hands by then and stays valid until
 * its own deadline.
 */
export async function reserveX402Spend(
  session: Session,
  req: X402Requirement,
  opts: X402SpendCapOptions & { url?: string } = {},
): Promise<{ status: X402SpendCapStatus; release: () => void }> {
  const token = req.asset as Address;
  const amount = amountOf(req);
  const caps = capsOn(session, token);
  if (caps.length === 0) return { status: { ok: true, token, amount, caps: [] }, release: () => {} };

  const client = clientFor(req, opts);
  const infos = await readSpendInfos(session, client);
  // No await between measuring and counting.
  const status = evaluate(session, token, amount, caps, infos, opts.now ?? Date.now() / 1000);
  if (!status.ok) throw await x402SpendCapError(status, { ...(client ? { publicClient: client } : {}), ...(opts.url ? { url: opts.url } : {}) });

  const keys = status.caps.map((c) => tallyKey(session, token, c.period, c.periodStart));
  for (const key of keys) signed.set(key, (signed.get(key) ?? 0n) + amount);
  let released = false;
  return {
    status,
    release: () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const left = (signed.get(key) ?? 0n) - amount;
        if (left > 0n) signed.set(key, left);
        else signed.delete(key);
      }
    },
  };
}

const PERIOD_WORD: Record<Period, string> = {
  minute: "per minute",
  hour: "hourly",
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

/**
 * The refusal, as the same `spend_limit_exceeded` an over-limit `execute`
 * gets, in the token's own units when its symbol and decimals can be read.
 */
export async function x402SpendCapError(
  status: X402SpendCapStatus,
  opts: { publicClient?: PublicClient; url?: string } = {},
): Promise<AltanaError> {
  const cap = status.caps.find((c) => !c.ok) ?? status.caps[0];
  const [symbol, decimals] = opts.publicClient
    ? await Promise.all([
        opts.publicClient
          .readContract({ address: status.token, abi: erc20Abi, functionName: "symbol" })
          .catch(() => undefined),
        opts.publicClient
          .readContract({ address: status.token, abi: erc20Abi, functionName: "decimals" })
          .catch(() => undefined),
      ])
    : [undefined, undefined];
  const readable = typeof symbol === "string" && typeof decimals === "number";
  const show = (raw: bigint) =>
    readable ? `${formatUnits(raw, decimals)} ${symbol}` : `${raw} base units of ${status.token}`;

  const where = opts.url ? ` for ${opts.url}` : "";
  const statement = cap
    ? `This session key's spending limit does not cover this payment${where}: it asks ${show(status.amount)}, ` +
      `and ${show(cap.remaining)} of the ${show(cap.limit)} ${PERIOD_WORD[cap.period]} limit is left.`
    : `This session key's spending limit does not cover this payment${where}.`;
  return new AltanaError({
    code: "spend_limit_exceeded",
    statement,
    action: "Grant a new session key with a higher limit, as limits cannot be raised.",
    detail:
      `x402 payment refused before signing. token ${status.token}, amount ${status.amount}` +
      (cap
        ? `, ${cap.period} limit ${cap.limit}, spent through execute ${cap.spentOnChain}, signed for x402 ${cap.spentX402}, period start ${cap.periodStart}`
        : ""),
  });
}
