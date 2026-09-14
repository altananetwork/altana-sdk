/**
 * The block a relayed registry write landed in: read from the relay's own receipt, with a
 * retried public RPC lookup only when the relay left it out, and an explicit reason when it
 * stays unknown (a cache proof must never be built without it).
 */
import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { blockNumberOfWrite, receiptBlockNumber, waitForCalls } from "./relay.js";

const TX = ("0x" + "ab".repeat(32)) as Hex;
// Sepolia block the run 3 registration was mined in.
const REGISTRATION_BLOCK = 11703373n;

describe("receiptBlockNumber", () => {
  test("reads porto's decoded number, hex, and bigint", () => {
    expect(receiptBlockNumber({ blockNumber: 11703373 })).toBe(REGISTRATION_BLOCK);
    expect(receiptBlockNumber({ blockNumber: "0xb2944d" })).toBe(REGISTRATION_BLOCK);
    expect(receiptBlockNumber({ blockNumber: REGISTRATION_BLOCK })).toBe(REGISTRATION_BLOCK);
  });

  test("undefined when the receipt has none", () => {
    expect(receiptBlockNumber({ transactionHash: TX })).toBeUndefined();
    expect(receiptBlockNumber(undefined)).toBeUndefined();
  });
});

describe("waitForCalls", () => {
  test("passes the first receipt's block number through from the relay's wire response", async () => {
    const client = {
      request: async () => ({
        id: "0x01",
        status: 200,
        receipts: [
          {
            blockHash: ("0x" + "11".repeat(32)) as Hex,
            blockNumber: "0xb2944d",
            chainId: "0xaa36a7",
            gasUsed: "0x5208",
            logs: [],
            status: "0x1",
            transactionHash: TX,
          },
        ],
      }),
    } as any;
    const result = await waitForCalls(client, "0x01", 5_000, 1);
    expect(result.status).toBe("CONFIRMED");
    expect(result.transactionHash).toBe(TX);
    expect(result.blockNumber).toBe(REGISTRATION_BLOCK);
  });
});

describe("blockNumberOfWrite", () => {
  const noSleep = async () => {};

  test("uses the relay's block without asking the public RPC", async () => {
    let lookups = 0;
    const publicClient = { getTransactionReceipt: async () => { lookups++; throw new Error("unused"); } } as any;
    const result = await blockNumberOfWrite({ relayBlockNumber: REGISTRATION_BLOCK, transactionHash: TX, publicClient });
    expect(result.blockNumber).toBe(REGISTRATION_BLOCK);
    expect(lookups).toBe(0);
  });

  test("falls back to the public RPC and retries while it has not indexed the transaction", async () => {
    let lookups = 0;
    const publicClient = {
      getTransactionReceipt: async () => {
        lookups++;
        if (lookups < 3) throw new Error("TransactionReceiptNotFoundError: receipt not found");
        return { blockNumber: REGISTRATION_BLOCK };
      },
    } as any;
    const result = await blockNumberOfWrite({ relayBlockNumber: undefined, transactionHash: TX, publicClient, sleep: noSleep });
    expect(result.blockNumber).toBe(REGISTRATION_BLOCK);
    expect(lookups).toBe(3);
  });

  test("an unknown block comes back with its reason instead of being swallowed", async () => {
    let lookups = 0;
    const publicClient = {
      getTransactionReceipt: async () => {
        lookups++;
        throw new Error("TransactionReceiptNotFoundError: receipt not found");
      },
    } as any;
    const result = await blockNumberOfWrite({
      relayBlockNumber: undefined,
      transactionHash: TX,
      publicClient,
      attempts: 4,
      sleep: noSleep,
    });
    expect(result.blockNumber).toBeUndefined();
    expect("blockNumberError" in result && result.blockNumberError).toContain("failed 4 times");
    expect(lookups).toBe(4);
  });
});
