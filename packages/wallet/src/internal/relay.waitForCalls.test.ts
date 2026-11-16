/**
 * waitForCalls on a bundle that spans two chains.
 *
 * A funded registry write locks the payer's funds on the source chain and runs
 * on the registry chain after. On Celo mainnet, 2026-11-14, the relay mined the
 * source leg in seconds and the registry leg fourteen minutes later. The SDK
 * had stopped at four, reported "no receipt at all" while 29 CELO sat in the
 * escrow, and abandoned the write that depended on it.
 *
 * The relay client is a `{ request }` stub, so the real status decode runs.
 */
import { describe, expect, test } from "bun:test";
import { pad, type Hex } from "viem";
import { waitForCalls, type RelayReceipt } from "./relay.js";

const SOURCE_CHAIN = "0xa4ec"; // Celo
const REGISTRY_CHAIN = 1; // Ethereum
const SOURCE_TX = pad("0xaa", { size: 32 }) as Hex;
const REGISTRY_TX = pad("0xbb", { size: 32 }) as Hex;

const receipt = (chainId: string, transactionHash: Hex, status = "0x1") => ({
  blockHash: pad("0xab", { size: 32 }),
  blockNumber: "0x1",
  chainId,
  gasUsed: "0x5208",
  status,
  transactionHash,
  logs: [],
});
const inFlight = (receipts: unknown[]) => ({ id: "0xcallsid", status: 100, receipts });
const confirmed = () => ({
  id: "0xcallsid",
  status: 200,
  receipts: [receipt(SOURCE_CHAIN, SOURCE_TX), receipt("0x1", REGISTRY_TX)],
});

/** A relay that answers `before` until `afterMs` have passed since the first poll, then `after`. */
function relay(before: unknown, after?: unknown, afterMs = 0) {
  let firstPollAt: number | undefined;
  let polls = 0;
  const client = {
    request: async () => {
      polls++;
      firstPollAt ??= Date.now();
      return after !== undefined && Date.now() - firstPollAt >= afterMs ? after : before;
    },
  } as any;
  return { client, polls: () => polls };
}

describe("waitForCalls on a funded cross-chain bundle", () => {
  test("a timed-out PENDING carries the receipts the relay had reported", async () => {
    const { client } = relay(inFlight([receipt(SOURCE_CHAIN, SOURCE_TX)]));
    const result = await waitForCalls(client, "0xcallsid", 40, 5, { chainId: REGISTRY_CHAIN });
    expect(result.status).toBe("PENDING");
    expect(result.statusCode).toBe(100);
    // The source leg was mined: that is where the payment is.
    expect(result.receipts).toHaveLength(1);
    expect(result.sourceReceipts?.[0]?.transactionHash).toBe(SOURCE_TX);
  });

  test("while the payment is locked the wait goes on, and returns the confirmation that comes late", async () => {
    const { client } = relay(inFlight([receipt(SOURCE_CHAIN, SOURCE_TX)]), confirmed(), 150);
    const waiting: (readonly RelayReceipt[])[] = [];
    const result = await waitForCalls(client, "0xcallsid", 30, 5, {
      chainId: REGISTRY_CHAIN,
      whileFundsLocked: { timeoutMs: 5_000, pollIntervalMs: 5, onWaiting: (r) => waiting.push(r) },
    });
    expect(result.status).toBe("CONFIRMED");
    // The receipt on the intent's own chain is the one reported as the write.
    expect(result.transactionHash).toBe(REGISTRY_TX);
    expect(result.sourceReceipts?.[0]?.transactionHash).toBe(SOURCE_TX);
    // Said once, with the leg that holds the payment.
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.[0]?.transactionHash).toBe(SOURCE_TX);
  });

  test("the longer wait has an end of its own", async () => {
    const { client } = relay(inFlight([receipt(SOURCE_CHAIN, SOURCE_TX)]));
    let said = 0;
    const started = Date.now();
    const result = await waitForCalls(client, "0xcallsid", 20, 5, {
      chainId: REGISTRY_CHAIN,
      whileFundsLocked: { timeoutMs: 120, pollIntervalMs: 5, onWaiting: () => said++ },
    });
    expect(result.status).toBe("PENDING");
    expect(result.receipts).toHaveLength(1);
    expect(said).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("with no source leg mined nothing is locked, and the wait ends at the first deadline", async () => {
    const { client } = relay(inFlight([]));
    let said = 0;
    const started = Date.now();
    const result = await waitForCalls(client, "0xcallsid", 30, 5, {
      chainId: REGISTRY_CHAIN,
      whileFundsLocked: { timeoutMs: 60_000, pollIntervalMs: 5, onWaiting: () => said++ },
    });
    expect(result.status).toBe("PENDING");
    expect(result.receipts).toBeUndefined();
    expect(said).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a source leg that reverted locked nothing", async () => {
    const { client } = relay(inFlight([receipt(SOURCE_CHAIN, SOURCE_TX, "0x0")]));
    let said = 0;
    const result = await waitForCalls(client, "0xcallsid", 30, 5, {
      chainId: REGISTRY_CHAIN,
      whileFundsLocked: { timeoutMs: 60_000, pollIntervalMs: 5, onWaiting: () => said++ },
    });
    expect(result.status).toBe("PENDING");
    expect(said).toBe(0);
    expect(result.sourceReceipts).toBeUndefined();
  });

  test("a failure reported during the longer wait ends it at once", async () => {
    const { client } = relay(
      inFlight([receipt(SOURCE_CHAIN, SOURCE_TX)]),
      { id: "0xcallsid", status: 300, receipts: [receipt(SOURCE_CHAIN, SOURCE_TX)] },
      80,
    );
    const started = Date.now();
    const result = await waitForCalls(client, "0xcallsid", 20, 5, {
      chainId: REGISTRY_CHAIN,
      whileFundsLocked: { timeoutMs: 60_000, pollIntervalMs: 5 },
    });
    expect(result.status).toBe("FAILED");
    expect(result.statusCode).toBe(300);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("without whileFundsLocked the wait is the one it always was", async () => {
    const { client } = relay(inFlight([receipt(SOURCE_CHAIN, SOURCE_TX)]), confirmed(), 400);
    const started = Date.now();
    const result = await waitForCalls(client, "0xcallsid", 30, 5, { chainId: REGISTRY_CHAIN });
    expect(result.status).toBe("PENDING");
    expect(Date.now() - started).toBeLessThan(300);
  });
});
