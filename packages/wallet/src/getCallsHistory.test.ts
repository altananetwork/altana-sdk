/**
 * Parsing the relay's call history.
 *
 * The fixture at the bottom is a real `wallet_getCallsHistory` entry, captured
 * from the live testnet relay on 2026-10-06 and trimmed only of the enormous
 * `quotes` array. Testing against the real shape is the point: the two things
 * that would break an activity feed, the [address, diffs] pair encoding in
 * assetDiffs and the "0x61" chain id, are both things a hand-written fixture
 * would quietly get wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  buildHistoryParams,
  clampLimit,
  hasLanded,
  isOwnerBundle,
  MAX_HISTORY_LIMIT,
  parseHistoryEntry,
  ZERO_KEY_HASH,
} from "./getCallsHistory.js";

const WALLET = "0xc211c942946011859ca634f22400d80570ed12a5";

describe("the request the relay actually accepts", () => {
  test("always sends sort, because the relay refuses the call without it", () => {
    expect(buildHistoryParams({ wallet: WALLET }).sort).toBe("desc");
    expect(buildHistoryParams({ wallet: WALLET, sort: "asc" }).sort).toBe("asc");
  });

  test("clamps limit to the relay's 1 to 100, rather than letting the read fail", () => {
    // Measured: 100 works, 101 is refused with "limit must be between 1 and 100".
    expect(clampLimit(500)).toBe(MAX_HISTORY_LIMIT);
    expect(clampLimit(101)).toBe(100);
    expect(clampLimit(100)).toBe(100);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(Number.NaN)).toBe(20);
    expect(clampLimit(7.9)).toBe(7);
  });

  test("omits index when there is none, and never sends a negative one", () => {
    expect(buildHistoryParams({ wallet: WALLET })).not.toHaveProperty("index");
    expect(buildHistoryParams({ wallet: WALLET, index: 20 }).index).toBe(20);
    expect(buildHistoryParams({ wallet: WALLET, index: -1 }).index).toBe(0);
  });
});

describe("attribution, which is what the feed is for", () => {
  test("a zero keyHash is the wallet's owner, not an agent", () => {
    expect(isOwnerBundle({ keyHash: ZERO_KEY_HASH })).toBe(true);
    expect(isOwnerBundle({ keyHash: ("0x" + "ab".repeat(32)) as `0x${string}` })).toBe(false);
  });

  test("case does not change who signed", () => {
    expect(isOwnerBundle({ keyHash: ZERO_KEY_HASH.toUpperCase().replace("0X", "0x") as `0x${string}` })).toBe(true);
  });

  test("an entry with no keyHash is refused, rather than silently read as the owner", () => {
    // Defaulting a missing keyHash to zero would credit an agent's spending to
    // the person, which is the worst possible way to be wrong here.
    const { keyHash: _drop, ...rest } = REAL_ENTRY;
    expect(() => parseHistoryEntry(rest)).toThrow(/no keyHash/);
  });

  test("an entry with no id is refused, since nothing could identify it", () => {
    const { id: _drop, ...rest } = REAL_ENTRY;
    expect(() => parseHistoryEntry(rest)).toThrow(/no id/);
  });
});

describe("parsing a real entry", () => {
  const entry = parseHistoryEntry(REAL_ENTRY);

  test("keeps identity, status and time", () => {
    expect(entry.id).toBe(REAL_ENTRY.id);
    expect(entry.index).toBe(0);
    expect(entry.status).toBe(200);
    expect(hasLanded(entry)).toBe(true);
    expect(entry.timestamp).toBe(1791295591);
  });

  test("reads the transactions, converting the hex chain id to a number", () => {
    expect(entry.transactions).toHaveLength(1);
    expect(entry.transactions[0]!.chainId).toBe(97);
    expect(entry.transactions[0]!.transactionHash).toBe(
      "0xed9e600dc88552158f84750bafd4a73e7d25bd8dc243bed27cca1d7d20a5ece3",
    );
  });

  test("unpacks assetDiffs from the [address, diffs] pairs the relay sends", () => {
    const forChain = entry.assetDiffs[97];
    expect(forChain).toBeDefined();
    const mine = forChain![WALLET as `0x${string}`];
    expect(mine).toHaveLength(1);
    expect(mine![0]!.direction).toBe("outgoing");
    expect(mine![0]!.value).toBe(0x244101b98a8ben);
    expect(mine![0]!.recipients).toHaveLength(2);
  });

  test("reads an incoming diff for another address in the same bundle", () => {
    const fee = entry.assetDiffs[97]!["0xb248602eaadd9c3e2db4575c4e4d58003b7a2740"];
    expect(fee![0]!.direction).toBe("incoming");
    expect(fee![0]!.value).toBe(0x825efe00c500n);
  });

  test("keeps the relay's symbol but flags why it must not be shown", () => {
    // The relay labels native BNB on chain 97 as "ETH". It is kept so a caller
    // can see what the relay said, and a UI maps the chain id instead.
    expect(entry.assetDiffs[97]![WALLET as `0x${string}`]![0]!.symbol).toBe("ETH");
    expect(entry.assetDiffs[97]![WALLET as `0x${string}`]![0]!.address).toBeNull();
  });

  test("reads the fee totals", () => {
    expect(entry.feeTotals["0x0"]).toEqual({ currency: "usd", value: "-0" });
  });
});

describe("a relay that changes shape must not break a feed", () => {
  test("missing capabilities yields empty diffs rather than throwing", () => {
    const entry = parseHistoryEntry({ ...REAL_ENTRY, capabilities: undefined });
    expect(entry.assetDiffs).toEqual({});
    expect(entry.feeTotals).toEqual({});
  });

  test("a transaction with no hash is dropped, not turned into a broken row", () => {
    const entry = parseHistoryEntry({
      ...REAL_ENTRY,
      transactions: [{ chainId: "0x61" }, REAL_ENTRY.transactions[0]],
    });
    expect(entry.transactions).toHaveLength(1);
  });

  test("a diff with no direction is dropped", () => {
    const entry = parseHistoryEntry({
      ...REAL_ENTRY,
      capabilities: { assetDiffs: { "0x61": [[WALLET, [{ value: "0x1" }]]] } },
    });
    expect(entry.assetDiffs[97]![WALLET as `0x${string}`]).toHaveLength(0);
  });

  test("a decimal chain id is read the same as a hex one", () => {
    const entry = parseHistoryEntry({
      ...REAL_ENTRY,
      capabilities: { assetDiffs: { 97: [[WALLET, [{ value: "0x1", direction: "incoming" }]]] } },
    });
    expect(entry.assetDiffs[97]).toBeDefined();
  });

  test("a decimal value string parses as well as a hex one", () => {
    const entry = parseHistoryEntry({
      ...REAL_ENTRY,
      capabilities: { assetDiffs: { "0x61": [[WALLET, [{ value: "1000", direction: "incoming" }]]] } },
    });
    expect(entry.assetDiffs[97]![WALLET as `0x${string}`]![0]!.value).toBe(1000n);
  });

  test("an unparseable value becomes zero rather than NaN or a throw", () => {
    const entry = parseHistoryEntry({
      ...REAL_ENTRY,
      capabilities: { assetDiffs: { "0x61": [[WALLET, [{ value: "banana", direction: "incoming" }]]] } },
    });
    expect(entry.assetDiffs[97]![WALLET as `0x${string}`]![0]!.value).toBe(0n);
  });

  test("a non-object entry is refused clearly", () => {
    expect(() => parseHistoryEntry(null)).toThrow(/not an object/);
    expect(() => parseHistoryEntry("0xabc")).toThrow(/not an object/);
  });
});

/**
 * A real entry from https://testnet-relay.altana.network, 2026-10-06, for
 * wallet 0xc211c942946011859ca634f22400d80570ed12a5 on chain 97. The `quotes`
 * array is removed; nothing else is edited.
 */
const REAL_ENTRY = {
  id: "0x167623b123074948d1a1b2e63b45fa2d1c35efb663fc5f6a0648ff60bd2762f0",
  index: 0,
  status: 200,
  timestamp: 1791295591,
  transactions: [
    {
      chainId: "0x61",
      transactionHash: "0xed9e600dc88552158f84750bafd4a73e7d25bd8dc243bed27cca1d7d20a5ece3",
    },
  ],
  keyHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  capabilities: {
    feeTotals: { "0x0": { currency: "usd", value: "-0" } },
    assetDiffs: {
      "0x61": [
        [
          "0xb248602eaadd9c3e2db4575c4e4d58003b7a2740",
          [
            {
              address: null,
              type: null,
              symbol: "ETH",
              decimals: 18,
              value: "0x825efe00c500",
              direction: "incoming",
              recipients: [],
            },
          ],
        ],
        [
          "0xc211c942946011859ca634f22400d80570ed12a5",
          [
            {
              address: null,
              type: null,
              symbol: "ETH",
              decimals: 18,
              value: "0x244101b98a8be",
              direction: "outgoing",
              recipients: [
                "0xb530d1971f5453f3359518343f05d0aedfff7e12",
                "0xb248602eaadd9c3e2db4575c4e4d58003b7a2740",
              ],
            },
          ],
        ],
      ],
    },
  },
} as const;
