/**
 * One key's transactions go strictly one after another: the next nonce is handed
 * out only after the previous transaction is **mined**, not merely sent.
 *
 * Why the distinction is the whole bug. An account's counter for a lane advances
 * when the intent executes. Hand out N+1 while N is unmined and the account is
 * still at N, so N+1 is not the nonce it will accept — the relay takes the
 * client's number, its simulation refuses it, and the bundle comes back FAILED
 * with no receipt and no reason. qa saw that on 8 of 10 back-to-back pairs on
 * the live testnet relay (2026-10-19).
 *
 * These run over a mocked fetch that plays the relay AND the account, with the
 * account's counter advancing only when a bundle is reported mined — which is
 * what makes "prepared too early" observable at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address, type Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { execute } from "./execute.js";
import { laneForKeyHash, laneNonce } from "./internal/appNonceLane.js";
import { keyHashForSigner } from "./internal/erc1271.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./internal/fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const CALLS = [{ to: "0x2222222222222222222222222222222222222222" as Address, value: 0n, data: "0x" as Hex }];
const GET_NONCE_SELECTOR = "0x3e1b0812";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Plays the relay and the account.
 *
 * `mine` controls when a bundle is reported CONFIRMED, and the account's lane
 * counter is the number of bundles mined so far — exactly as a chain behaves.
 * Every prepare is recorded with the counter it asked for AND how many bundles
 * were mined at that moment, which is the pair that catches a nonce handed out
 * too early.
 */
function mockWire(opts: { mine: "immediately" | "on-release"; failWithNoReceipts?: boolean } = { mine: "immediately" }) {
  const events: string[] = [];
  const prepares: { counter: bigint; minedWhenPrepared: number }[] = [];
  let mined = 0;
  /** Bundle ids cleared to mine. Empty and `mine: "on-release"` means none. */
  const cleared = new Set<string>();
  /** Bundles already counted, so a second poll of one does not mine it twice. */
  const counted = new Set<string>();
  const all = opts.mine === "immediately";
  let bundleSeq = 0;

  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
      if (req.method === "eth_call") {
        const data = String(req.params?.[0]?.data ?? "");
        if (data.startsWith(GET_NONCE_SELECTOR)) {
          const lane = BigInt(`0x${data.slice(10)}`);
          // The account has reached exactly as many nonces as bundles mined.
          return ok(numberToHex(laneNonce(lane, BigInt(mined)), { size: 32 }));
        }
        return ok("0x");
      }
      if (req.method === "eth_chainId") return ok(numberToHex(CELO_SEPOLIA.chainId));
      if (req.method === "wallet_getCapabilities") {
        return ok({ [numberToHex(CELO_SEPOLIA.chainId)]: capabilities["0xaa044c"] });
      }
      if (req.method === "wallet_getAssets") {
        return ok({
          [numberToHex(CELO_SEPOLIA.chainId)]: [
            { address: "native", balance: numberToHex(10n ** 18n), type: "native", metadata: null },
          ],
        });
      }
      if (req.method === "wallet_prepareCalls") {
        const sent = req.params?.[0]?.capabilities?.meta?.nonce;
        const counter = sent === undefined ? -1n : BigInt(sent) & ((1n << 64n) - 1n);
        prepares.push({ counter, minedWhenPrepared: mined });
        events.push(`prepare:${counter}@mined=${mined}`);
        return ok(prepared);
      }
      if (req.method === "wallet_sendPreparedCalls") {
        bundleSeq += 1;
        return ok({ id: `0x${bundleSeq.toString(16).padStart(2, "0")}` });
      }
      if (req.method === "wallet_getCallsStatus") {
        const id = String(req.params?.[0]);
        if (!all && !cleared.has(id)) return ok({ id, status: 100, receipts: [] });
        if (opts.failWithNoReceipts) {
          events.push("failed:no-receipts");
          return ok({ id: req.params?.[0], status: 300, receipts: [] });
        }
        if (!counted.has(id)) {
          counted.add(id);
          mined += 1;
          events.push(`mined:${mined}`);
        }
        return ok({
          id: req.params?.[0],
          status: 200,
          // The full receipt shape porto validates: a thinner one makes its
          // schema throw, which `waitForCalls` catches and retries for four
          // minutes -- so a malformed fixture looks exactly like a hang.
          receipts: [
            {
              chainId: numberToHex(CELO_SEPOLIA.chainId),
              transactionHash: `0x${"ab".repeat(32)}`,
              status: "0x1",
              blockNumber: "0x1",
              blockHash: `0x${"cd".repeat(32)}`,
              gasUsed: "0x1",
              logs: [],
            },
          ],
        });
      }
      throw new Error(`unexpected ${req.method}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;

  return {
    events,
    prepares,
    /** Let one bundle mine (1-based, in submission order), or all of them. */
    release: (n?: number) => cleared.add(n === undefined ? "all" : `0x${n.toString(16).padStart(2, "0")}`),
    releaseAll: () => {
      for (let i = 1; i <= 16; i++) cleared.add(`0x${i.toString(16).padStart(2, "0")}`);
    },
    minedCount: () => mined,
  };
}

const wallet = (n: number) => ({ address: `0x${n.toString(16).padStart(40, "0")}` as Address });
const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * Waits for something observable on the mock rather than for a duration.
 *
 * `await execute(...)` returning does not mean the NEXT transaction's prepare
 * has happened yet -- the lane releases, and the one behind it runs on a later
 * turn. Asserting right after the await measured the scheduler.
 */
async function until(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error(`timed out waiting for: ${what}`);
}

/**
 * Lets every bundle mine and waits for the pollers to finish.
 *
 * Needed because a `noWait` caller leaves a poller running: without draining
 * it, it outlives the test and polls whatever `globalThis.fetch` the NEXT test
 * installed, which is how two of these first reported counters from another
 * test's mock.
 */
async function drain(wire: { releaseAll: () => void; minedCount: () => number }, bundles: number) {
  wire.releaseAll();
  await until(`${bundles} bundles mined`, () => wire.minedCount() >= bundles).catch(() => undefined);
}

describe("a key's transactions wait for the previous one to be MINED", () => {
  test("the second is not prepared while the first is unmined", async () => {
    // The gate for this change, and it is deliberately not timing-dependent:
    // the first bundle cannot mine until this test says so, so "did the second
    // get prepared early" has one answer rather than whichever the event loop
    // happened to produce.
    const wire = mockWire({ mine: "on-release" });
    const w = wallet(0xd1);
    const signer = createPrivateKeySigner();

    const first = execute(w, signer, CALLS, { network: CELO_SEPOLIA });
    const second = execute(w, signer, CALLS, { network: CELO_SEPOLIA });
    await until("the first prepare", () => wire.prepares.length === 1);
    await tick();

    // STILL one prepare. Releasing the lane at submission put the second
    // prepare here, carrying counter 1 while the account was still at 0.
    expect(wire.prepares).toHaveLength(1);
    expect(wire.prepares[0]).toEqual({ counter: 0n, minedWhenPrepared: 0 });

    wire.release(1);
    await first;
    await until("the second prepare", () => wire.prepares.length === 2);
    wire.release(2);
    await second;

    // No prepare ever asked for a counter the account had not reached.
    for (const p of wire.prepares) expect(p.counter).toBe(BigInt(p.minedWhenPrepared));
    expect(wire.prepares.map((p) => p.counter)).toEqual([0n, 1n]);
    expect(wire.events).toEqual(["prepare:0@mined=0", "mined:1", "prepare:1@mined=1", "mined:2"]);
  }, 20_000);

  test("three in a row each wait for the one before", async () => {
    const wire = mockWire({ mine: "on-release" });
    const w = wallet(0xd2);
    const signer = createPrivateKeySigner();
    const all = [1, 2, 3].map(() => execute(w, signer, CALLS, { network: CELO_SEPOLIA }));

    await until("the first prepare", () => wire.prepares.length === 1);
    await tick();
    expect(wire.prepares).toHaveLength(1);

    wire.release(1);
    await all[0];
    await until("the second prepare", () => wire.prepares.length === 2);
    await tick();
    expect(wire.prepares).toHaveLength(2);

    wire.release(2);
    await all[1];
    await until("the third prepare", () => wire.prepares.length === 3);
    wire.release(3);
    await all[2];

    expect(wire.prepares.map((p) => p.counter)).toEqual([0n, 1n, 2n]);
    for (const p of wire.prepares) expect(p.counter).toBe(BigInt(p.minedWhenPrepared));
  }, 30_000);

  test("noWait returns at once but still holds the lane until the bundle settles", async () => {
    const wire = mockWire({ mine: "on-release" });
    const w = wallet(0xd3);
    const signer = createPrivateKeySigner();

    const first = await execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true });
    expect(first.status).toBe("PENDING");

    // The caller has its answer; the lane has not been released.
    const second = execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true });
    await tick();
    await tick();
    expect(wire.prepares).toHaveLength(1);

    // Let only the first mine: the second may go now, and not before.
    wire.release(1);
    await second;
    await until("the second prepare", () => wire.prepares.length === 2);
    expect(wire.prepares.map((p) => p.counter)).toEqual([0n, 1n]);
    for (const p of wire.prepares) expect(p.counter).toBe(BigInt(p.minedWhenPrepared));
    await drain(wire, 2);
  }, 30_000);

  test("a different key is on its own lane and waits for none of it", async () => {
    const wire = mockWire({ mine: "on-release" });
    const w = wallet(0xd4);
    const a = createPrivateKeySigner();
    const b = createPrivateKeySigner();

    // A is left unmined on purpose.
    void execute(w, a, CALLS, { network: CELO_SEPOLIA, noWait: true });
    await tick();
    expect(wire.prepares).toHaveLength(1);

    // B goes anyway: different key, different lane, nothing to wait for.
    const bResult = await execute(w, b, CALLS, { network: CELO_SEPOLIA, noWait: true });
    expect(bResult.status).toBe("PENDING");
    expect(wire.prepares).toHaveLength(2);
    wire.releaseAll();
  }, 15_000);
});

describe("a bundle the relay never broadcast", () => {
  test("is an error naming the nonce, its lane and the bundle, not a bare status", async () => {
    const wire = mockWire({ mine: "immediately", failWithNoReceipts: true });
    const w = wallet(0xd5);
    const signer = createPrivateKeySigner();
    const lane = laneForKeyHash(keyHashForSigner(signer));

    const err = await execute(w, signer, CALLS, { network: CELO_SEPOLIA }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err).toBeDefined();
    const message = err!.message;
    // The three things a reader needs, which a status code alone gives none of.
    expect(message).toContain("nonce");
    expect(message).toContain(`counter 0 on lane 0x${lane.toString(16)}`);
    expect(message).toContain("0x01"); // the bundle id
    expect(message).toContain("no receipt");
    expect(message).toContain("status code 300");
    // And it says which investigation this is NOT.
    expect(message).toContain("never reached a block");
    expect(wire.events).toContain("failed:no-receipts");
  });

  test("and the lane is dropped, so the next transaction re-reads the chain", async () => {
    const wire = mockWire({ mine: "immediately", failWithNoReceipts: true });
    const w = wallet(0xd6);
    const signer = createPrivateKeySigner();

    await execute(w, signer, CALLS, { network: CELO_SEPOLIA }).catch(() => undefined);
    await execute(w, signer, CALLS, { network: CELO_SEPOLIA }).catch(() => undefined);

    // Nothing mined, so the account is still at 0 and both asked for 0 --
    // rather than the second insisting on 1 off a local counter.
    expect(wire.prepares.map((p) => p.counter)).toEqual([0n, 0n]);
  });
});
