/**
 * Everything a wallet has done through the relay, newest first.
 *
 * The relay keeps a record of every bundle it executed for an account, and this
 * is the only source for two things nothing on-chain gives you directly: which
 * key signed a bundle, and what each bundle moved. So it is the backbone of an
 * activity feed, and `keyHash` is what attributes a transaction to the agent
 * that made it.
 *
 * Three things about `wallet_getCallsHistory` that are easy to get wrong, all
 * measured against the live testnet relay rather than read from a document:
 *
 *  - **`sort` is required.** Leaving it out is a hard "missing field sort",
 *    not a default.
 *  - **`limit` must be 1 to 100.** Anything larger is refused outright, so this
 *    clamps rather than letting a caller's 500 fail the whole read.
 *  - **`index` is an offset into the sorted page, not an identity.** With
 *    `sort: "desc"` index 0 is the newest entry; with `"asc"` it is the oldest,
 *    so the same bundle carries two different index values. Page by adding
 *    `limit` to the offset in one fixed direction, and identify a bundle by its
 *    `id`, never by its index.
 */

import { hexToBigInt, type Address, type Hex } from "viem";
import { buildRelayClient } from "./internal/relay.js";
import type { NetworkConfig } from "./config.js";

/** The relay's cap. Asking for more is refused, not truncated. */
export const MAX_HISTORY_LIMIT = 100;

export type CallsHistorySort = "asc" | "desc";

export type CallsHistoryOptions = {
  wallet: Address;
  /** How many bundles. Clamped to 1..100, which is what the relay accepts. */
  limit?: number;
  /** Offset into the sorted list. Not a bundle identity. */
  index?: number;
  /** Newest first by default. */
  sort?: CallsHistorySort;
};

/** One transaction inside a bundle. A bundle can span chains. */
export type CallsHistoryTransaction = {
  chainId: number;
  transactionHash: Hex;
};

/** What a bundle moved, for one address on one chain. */
export type AssetDiff = {
  /** Null for the chain's native token. */
  address: Address | null;
  /** The relay's label. Do not show it: on chain 97 it reports BNB as "ETH". */
  symbol: string | null;
  decimals: number | null;
  value: bigint;
  direction: "incoming" | "outgoing";
  recipients: readonly Address[];
};

export type CallsHistoryEntry = {
  /** The bundle's identity. Stable, unlike `index`. */
  id: Hex;
  index: number;
  /** The relay's status code; 200 is a landed bundle. */
  status: number;
  /** Seconds since the epoch. */
  timestamp: number;
  transactions: readonly CallsHistoryTransaction[];
  /**
   * The key that signed this bundle.
   *
   * Zero means the wallet's own owner key: the person did this. Anything else
   * is a registered key, and matching it against `keyHashForSessionOrKey` of a
   * session is how a transaction is attributed to an agent.
   */
  keyHash: Hex;
  /** Who gained and lost what, keyed by chain id then by address. */
  assetDiffs: Record<number, Record<Address, readonly AssetDiff[]>>;
  /** The fee the bundle paid, by currency, as the relay reported it. */
  feeTotals: Record<string, { currency: string; value: string }>;
};

export const ZERO_KEY_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** True when the wallet's own owner key signed this, rather than a session. */
export function isOwnerBundle(entry: Pick<CallsHistoryEntry, "keyHash">): boolean {
  return entry.keyHash.toLowerCase() === ZERO_KEY_HASH;
}

/** A landed bundle. The relay reports HTTP-like status codes. */
export function hasLanded(entry: Pick<CallsHistoryEntry, "status">): boolean {
  return entry.status === 200;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 20;
  const whole = Math.floor(limit);
  if (whole < 1) return 1;
  if (whole > MAX_HISTORY_LIMIT) return MAX_HISTORY_LIMIT;
  return whole;
}

/** The request the relay actually wants. Exported so it can be asserted on. */
export function buildHistoryParams(opts: CallsHistoryOptions) {
  return {
    address: opts.wallet,
    limit: clampLimit(opts.limit),
    // Required. The relay refuses the call without it.
    sort: opts.sort ?? "desc",
    ...(opts.index !== undefined ? { index: Math.max(0, Math.floor(opts.index)) } : {}),
  };
}

/**
 * Normalise one raw entry.
 *
 * Deliberately forgiving about everything except identity: a relay that adds a
 * field, or omits one we do not need, must not break an activity feed. A missing
 * `id` or `keyHash` is different, because both are load-bearing.
 */
export function parseHistoryEntry(raw: unknown): CallsHistoryEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("getCallsHistory: the relay returned an entry that is not an object.");
  }
  const e = raw as Record<string, unknown>;

  const id = typeof e.id === "string" ? (e.id as Hex) : undefined;
  if (!id) throw new Error("getCallsHistory: an entry arrived with no id.");

  const keyHash = typeof e.keyHash === "string" ? (e.keyHash as Hex) : undefined;
  if (!keyHash) {
    throw new Error(`getCallsHistory: bundle ${id} arrived with no keyHash, so it cannot be attributed.`);
  }

  const capabilities = asRecord(e.capabilities);

  return {
    id,
    index: asNumber(e.index) ?? 0,
    status: asNumber(e.status) ?? 0,
    timestamp: asNumber(e.timestamp) ?? 0,
    transactions: Array.isArray(e.transactions)
      ? e.transactions.flatMap((t) => {
          const tx = asRecord(t);
          const hash = typeof tx.transactionHash === "string" ? (tx.transactionHash as Hex) : undefined;
          if (!hash) return [];
          return [{ chainId: asChainId(tx.chainId) ?? 0, transactionHash: hash }];
        })
      : [],
    keyHash,
    assetDiffs: parseAssetDiffs(capabilities.assetDiffs),
    feeTotals: parseFeeTotals(capabilities.feeTotals),
  };
}

function parseAssetDiffs(raw: unknown): CallsHistoryEntry["assetDiffs"] {
  const out: CallsHistoryEntry["assetDiffs"] = {};
  const byChain = asRecord(raw);

  for (const [chainKey, perAddress] of Object.entries(byChain)) {
    const chainId = asChainId(chainKey);
    if (chainId === undefined || !Array.isArray(perAddress)) continue;

    const forChain: Record<Address, readonly AssetDiff[]> = {};
    // The relay sends [address, diffs] pairs rather than an object, so the
    // shape has to be unpacked rather than spread.
    for (const pair of perAddress) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [address, diffs] = pair as [unknown, unknown];
      if (typeof address !== "string" || !Array.isArray(diffs)) continue;

      forChain[address.toLowerCase() as Address] = diffs.flatMap((d) => {
        const diff = asRecord(d);
        const direction = diff.direction === "incoming" || diff.direction === "outgoing"
          ? diff.direction
          : undefined;
        if (!direction) return [];
        return [
          {
            address: typeof diff.address === "string" ? (diff.address as Address) : null,
            symbol: typeof diff.symbol === "string" ? diff.symbol : null,
            decimals: asNumber(diff.decimals) ?? null,
            value: asBigInt(diff.value),
            direction,
            recipients: Array.isArray(diff.recipients)
              ? diff.recipients.filter((r): r is Address => typeof r === "string")
              : [],
          },
        ];
      });
    }
    out[chainId] = forChain;
  }
  return out;
}

function parseFeeTotals(raw: unknown): CallsHistoryEntry["feeTotals"] {
  const out: CallsHistoryEntry["feeTotals"] = {};
  for (const [key, value] of Object.entries(asRecord(raw))) {
    const fee = asRecord(value);
    out[key] = {
      currency: typeof fee.currency === "string" ? fee.currency : "",
      value: typeof fee.value === "string" ? fee.value : String(fee.value ?? "0"),
    };
  }
  return out;
}

/**
 * Read a page of the wallet's relay history.
 *
 * One page per call, because paging belongs to whatever is rendering: a feed
 * that fetches everything before showing anything is a feed that shows nothing
 * for a while.
 */
export async function getCallsHistory(
  network: NetworkConfig,
  opts: CallsHistoryOptions,
): Promise<CallsHistoryEntry[]> {
  const relay = buildRelayClient(network);
  const params = buildHistoryParams(opts);

  const raw = (await relay.request({
    method: "wallet_getCallsHistory" as never,
    params: [params] as never,
  })) as unknown;

  if (!Array.isArray(raw)) return [];
  return raw.map(parseHistoryEntry);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const n = value.startsWith("0x") ? Number.parseInt(value, 16) : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Chain ids arrive as "0x61" in some places and 97 in others. */
function asChainId(value: unknown): number | undefined {
  return asNumber(value);
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") {
    try {
      return value.startsWith("0x") ? hexToBigInt(value as Hex) : BigInt(value);
    } catch {
      return 0n;
    }
  }
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return 0n;
}
