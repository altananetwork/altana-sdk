/**
 * What `execute` actually puts on the wire: `capabilities.meta.nonce` carrying
 * the SDK's own lane, over a mocked fetch that plays both the relay and the
 * public RPC.
 *
 * The lane module's own tests cover its arithmetic. These cover the part a
 * reader cannot check from them: that the nonce reaches the relay, that two
 * back-to-back transactions carry consecutive counters, and that a wallet which
 * is not delegated yet sends no nonce at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address, type Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { execute } from "./execute.js";
import { APP_LANE_PREFIX, laneForKeyHash, laneNonce } from "./internal/appNonceLane.js";
import { keyHashForSigner } from "./internal/erc1271.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./internal/fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const CALLS = [{ to: "0x2222222222222222222222222222222222222222" as Address, value: 0n, data: "0x" as Hex }];
/** `getNonce(uint192)` — what the SDK asks the account for. */
const GET_NONCE_SELECTOR = "0x3e1b0812";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Plays the relay and the public RPC. `laneCounter` is what the account answers
 * for the app lane; "undelegated" makes that read revert, as it does before a
 * wallet's delegation lands.
 */
function mockWire(laneCounter: bigint | "undelegated") {
  const nonces: (string | undefined)[] = [];
  const lanesAsked: bigint[] = [];
  /** Mined count PER LANE: each lane has its own counter, as the account does. */
  const minedByLane = new Map<string, number>();
  /** Bundle id -> the lane its prepare used, so settling advances the right one. */
  const laneOfBundle = new Map<string, string>();
  const counted = new Set<string>();
  let getNonceCalls = 0;
  let lastPreparedLane = "";
  let bundleSeq = 0;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
      if (req.method === "eth_call") {
        const data = String(req.params?.[0]?.data ?? "");
        if (data.startsWith(GET_NONCE_SELECTOR)) {
          getNonceCalls += 1;
          // The lane is the call's only argument, so the mock can report which
          // lane the SDK asked about as well as answer it.
          const lane = BigInt(`0x${data.slice(10)}`);
          lanesAsked.push(lane);
          if (laneCounter === "undelegated") {
            return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted" } };
          }
          // Advances as that lane's bundles mine, like the account: the SDK
          // reads this only once the previous intent has landed, so a frozen
          // answer would describe a chain that never moves -- and a count
          // shared between lanes would describe one counter, which is the very
          // thing per-key lanes are not.
          const minedHere = BigInt(minedByLane.get(lane.toString(16)) ?? 0);
          return ok(numberToHex(laneNonce(lane, laneCounter + minedHere), { size: 32 }));
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
        nonces.push(sent);
        lastPreparedLane = sent === undefined ? "" : (BigInt(sent) >> 64n).toString(16);
        return ok(prepared);
      }
      if (req.method === "wallet_sendPreparedCalls") {
        bundleSeq += 1;
        const id = `0x${bundleSeq.toString(16).padStart(3, "0")}`;
        laneOfBundle.set(id, lastPreparedLane);
        return ok({ id });
      }
      if (req.method === "wallet_getCallsStatus") {
        const id = String(req.params?.[0]);
        if (!counted.has(id)) {
          counted.add(id);
          const lane = laneOfBundle.get(id) ?? "";
          if (lane) minedByLane.set(lane, (minedByLane.get(lane) ?? 0) + 1);
        }
        // Needed since the lane is held until the bundle is MINED: a second
        // transaction on one key waits for this, even under `noWait`. The
        // receipt carries every field porto validates, because a thinner one
        // makes its schema throw and `waitForCalls` then retries for minutes.
        return ok({
          id: req.params?.[0],
          status: 200,
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
  return { nonces, lanesAsked, getNonceCalls: () => getNonceCalls };
}

const wallet = (n: number) => ({ address: `0x${n.toString(16).padStart(40, "0")}` as Address });
const run = (w: { address: Address }, signer = createPrivateKeySigner()) =>
  execute(w, signer, CALLS, { network: CELO_SEPOLIA, noWait: true });

describe("execute puts an app transaction on the SDK's lane", () => {
  test("the prepare carries a nonce on the SIGNING KEY's lane, not lane 0", async () => {
    const wire = mockWire(3n);
    const signer = createPrivateKeySigner();
    const result = await run(wallet(0xc1), signer);

    expect(result.callsId).toMatch(/^0x[0-9a-f]+$/);
    expect(wire.nonces).toHaveLength(1);
    const sent = BigInt(wire.nonces[0]!);
    // The lane is the one derived from the key that signed, not a fixed one.
    expect(sent >> 64n).toBe(laneForKeyHash(keyHashForSigner(signer)));
    expect(sent >> 240n).toBe(APP_LANE_PREFIX);
    expect(sent & ((1n << 64n) - 1n)).toBe(3n);
    // The thing this is all for: not the lane the relay allocates from.
    expect(sent >> 64n).not.toBe(0n);
    // And it asked the account about that lane.
    expect(wire.lanesAsked).toEqual([laneForKeyHash(keyHashForSigner(signer))]);
  });

  test("two different signers on one wallet use two different lanes", async () => {
    const wire = mockWire(0n);
    const w = wallet(0xc4);
    const a = createPrivateKeySigner();
    const b = createPrivateKeySigner();
    await run(w, a);
    await run(w, b);

    const [first, second] = wire.nonces.map((n) => BigInt(n!));
    expect(first! >> 64n).toBe(laneForKeyHash(keyHashForSigner(a)));
    expect(second! >> 64n).toBe(laneForKeyHash(keyHashForSigner(b)));
    expect(first! >> 64n).not.toBe(second! >> 64n);
    // Each starts from its own lane's counter rather than continuing the other's.
    expect(first! & ((1n << 64n) - 1n)).toBe(0n);
    expect(second! & ((1n << 64n) - 1n)).toBe(0n);
  });

  test("one key's back-to-back transactions carry consecutive counters", async () => {
    // The account's answer never changes, which is exactly the read-after-write
    // case that hands out one nonce twice on lane 0.
    const wire = mockWire(0n);
    const w = wallet(0xc2);
    const signer = createPrivateKeySigner();
    await run(w, signer);
    await run(w, signer);
    await run(w, signer);

    expect(wire.nonces.map((n) => BigInt(n!) & ((1n << 64n) - 1n))).toEqual([0n, 1n, 2n]);
    const lane = laneForKeyHash(keyHashForSigner(signer));
    expect(wire.nonces.every((n) => BigInt(n!) >> 64n === lane)).toBe(true);
  });

  test("an undelegated wallet sends no nonce, leaving the relay to choose", async () => {
    const wire = mockWire("undelegated");
    const result = await run(wallet(0xc3));

    expect(result.callsId).toMatch(/^0x[0-9a-f]+$/);
    expect(wire.nonces).toEqual([undefined]);
    expect(wire.getNonceCalls()).toBeGreaterThan(0);
  });
});
