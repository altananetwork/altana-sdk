/**
 * readTokenBalances must apply the BEP-677 scaled-UI-amount multiplier to the
 * DISPLAY value only (raw stays the on-chain amount), gate all scaling on the
 * ERC-165 detection results, and never let one bad token poison the batch.
 */
import { test, expect, mock, afterEach } from "bun:test";
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionResult,
  formatUnits,
  http,
  multicall3Abi,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { bsc } from "viem/chains";
import {
  readTokenBalances,
  applyUiMultiplier,
  UI_MULTIPLIER_ONE,
  SCALED_UI_AMOUNT_INTERFACE_ID,
  MULTICALL_BATCH_SIZE,
  TOKENS_PER_CHUNK,
  CHUNK_CONCURRENCY,
} from "./tokenBalances.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const TOKEN_A: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const BLOCK_TS = 1_800_000_000n;

const ok = (result: unknown) => ({ status: "success" as const, result });
const fail = () => ({
  status: "failure" as const,
  error: new Error("reverted"),
});

/**
 * Per-token result row, positionally matching the speculative multicall:
 * [balanceOf, decimals, symbol:string, symbol:bytes32,
 *  supportsInterface(scaled), supportsInterface(pending),
 *  uiMultiplier, newUIMultiplier, effectiveAt]
 */
type Row = ReturnType<typeof ok | typeof fail>[];

function plainErc20(raw: bigint, decimals = 18, symbol = "TOK"): Row {
  // USDT-style: no ERC-165 at all — every extension call reverts.
  return [ok(raw), ok(decimals), ok(symbol), fail(), fail(), fail(), fail(), fail(), fail()];
}

function bep677(o: {
  raw: bigint;
  decimals?: number;
  uiMultiplier: bigint;
  newUIMultiplier?: bigint;
  effectiveAt?: bigint;
}): Row {
  const hasPending = o.newUIMultiplier !== undefined;
  return [
    ok(o.raw),
    ok(o.decimals ?? 18),
    ok("sTOK"),
    fail(),
    ok(true),
    ok(hasPending),
    ok(o.uiMultiplier),
    hasPending ? ok(o.newUIMultiplier) : fail(),
    hasPending ? ok(o.effectiveAt ?? 0n) : fail(),
  ];
}

function makeClient(rows: Row[], header: ReturnType<typeof ok | typeof fail> = ok(BLOCK_TS)) {
  const multicall = mock(async () => [header, ...rows.flat()]);
  const client = { chain: bsc, multicall } as unknown as PublicClient;
  return { client, multicall };
}

test("plain ERC-20 (non-ERC-165, USDT-style): no scaled, display = formatUnits(raw)", async () => {
  const { client } = makeClient([plainErc20(5n * 10n ** 18n, 18, "USDT")]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.raw).toBe(5n * 10n ** 18n);
  expect(t.decimals).toBe(18);
  expect(t.symbol).toBe("USDT");
  expect(t.display).toBe("5");
  expect(t.scaled).toBeUndefined();
});

test("ERC-165 token answering false for IScaledUIAmount is NOT scaled even if uiMultiplier succeeds", async () => {
  const row: Row = [
    ok(100n), ok(0), ok("X"), fail(),
    ok(false), // supportsInterface(0xa60bf13d) → false: the gate
    ok(false),
    ok(2n * UI_MULTIPLIER_ONE), // speculative read "succeeded" — must be ignored
    fail(), fail(),
  ];
  const { client } = makeClient([row]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.scaled).toBeUndefined();
  expect(t.display).toBe("100");
});

test("BEP-677: display and scaledRaw carry the multiplier, raw does not", async () => {
  const { client } = makeClient([
    bep677({ raw: 2_000000n, decimals: 6, uiMultiplier: 15n * 10n ** 17n }),
  ]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.raw).toBe(2_000000n);
  expect(t.scaled?.scaledRaw).toBe(3_000000n);
  expect(t.scaled?.uiMultiplier).toBe(15n * 10n ** 17n);
  expect(t.display).toBe("3");
  expect(t.scaled?.pending).toBeUndefined();
});

test("scaling truncates toward zero per the spec formula", async () => {
  expect(applyUiMultiplier(1n, 5n * 10n ** 17n)).toBe(0n);
  const { client } = makeClient([
    bep677({ raw: 1n, decimals: 6, uiMultiplier: 5n * 10n ** 17n }),
  ]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.scaled?.scaledRaw).toBe(0n);
  expect(t.display).toBe("0");
});

test("pending change in the future: current multiplier used, pending populated", async () => {
  const { client } = makeClient([
    bep677({
      raw: 10n ** 18n,
      uiMultiplier: UI_MULTIPLIER_ONE,
      newUIMultiplier: 2n * UI_MULTIPLIER_ONE,
      effectiveAt: BLOCK_TS + 100n,
    }),
  ]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.display).toBe("1");
  expect(t.scaled?.uiMultiplier).toBe(UI_MULTIPLIER_ONE);
  expect(t.scaled?.pending).toEqual({
    newUIMultiplier: 2n * UI_MULTIPLIER_ONE,
    effectiveAt: BLOCK_TS + 100n,
  });
});

test("pending change already effective: newUIMultiplier applies, no pending", async () => {
  const { client } = makeClient([
    bep677({
      raw: 10n ** 18n,
      uiMultiplier: UI_MULTIPLIER_ONE, // lazy token still reporting the old value
      newUIMultiplier: 2n * UI_MULTIPLIER_ONE,
      effectiveAt: BLOCK_TS - 1n,
    }),
  ]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.display).toBe("2");
  expect(t.scaled?.uiMultiplier).toBe(2n * UI_MULTIPLIER_ONE);
  expect(t.scaled?.pending).toBeUndefined();
});

test("effectiveAt = 0 means no change was ever scheduled", async () => {
  const { client } = makeClient([
    bep677({
      raw: 10n ** 18n,
      uiMultiplier: 3n * UI_MULTIPLIER_ONE,
      newUIMultiplier: 3n * UI_MULTIPLIER_ONE,
      effectiveAt: 0n,
    }),
  ]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.display).toBe("3");
  expect(t.scaled?.uiMultiplier).toBe(3n * UI_MULTIPLIER_ONE);
  expect(t.scaled?.pending).toBeUndefined();
});

test("uiMultiplier = 0 displays 0, matching a compliant token's own UI amount", async () => {
  const { client } = makeClient([bep677({ raw: 10n ** 18n, uiMultiplier: 0n })]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.display).toBe("0");
  expect(t.scaled?.scaledRaw).toBe(0n);
});

test("a token whose balanceOf reverts yields ok:false without poisoning siblings", async () => {
  const bad: Row = [fail(), ok(18), ok("BAD"), fail(), fail(), fail(), fail(), fail(), fail()];
  const { client } = makeClient([bad, plainErc20(7n * 10n ** 18n, 18, "GOOD")]);
  const [a, b] = await readTokenBalances(client, OWNER, [TOKEN_A, TOKEN_B]);
  expect(a.ok).toBe(false);
  expect(a.address).toBe(TOKEN_A);
  if (a.ok) throw new Error("expected failure entry");
  expect(a.error).toContain("balanceOf");
  if (!b.ok) throw new Error(b.error);
  expect(b.symbol).toBe("GOOD");
  expect(b.display).toBe("7");
});

test("bytes32 symbol fallback (MKR-style) decodes and strips padding", async () => {
  const row: Row = [
    ok(10n ** 18n), ok(18),
    fail(), // string symbol() reverts
    ok(stringToHex("MKR", { size: 32 })),
    fail(), fail(), fail(), fail(), fail(),
  ];
  const { client } = makeClient([row]);
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.symbol).toBe("MKR");
});

test("empty tokens array short-circuits without any RPC call", async () => {
  const { client, multicall } = makeClient([]);
  const out = await readTokenBalances(client, OWNER, []);
  expect(out).toEqual([]);
  expect(multicall).not.toHaveBeenCalled();
});

test("header timestamp failure falls back to wall clock", async () => {
  // effectiveAt in the far future must still land in `pending` when the
  // block-timestamp header call fails and Date.now() is the reference.
  const farFuture = BigInt(Math.floor(Date.now() / 1000)) + 10n ** 9n;
  const { client } = makeClient(
    [
      bep677({
        raw: 10n ** 18n,
        uiMultiplier: UI_MULTIPLIER_ONE,
        newUIMultiplier: 2n * UI_MULTIPLIER_ONE,
        effectiveAt: farFuture,
      }),
    ],
    fail(),
  );
  const [t] = await readTokenBalances(client, OWNER, [TOKEN_A]);
  if (!t.ok) throw new Error(t.error);
  expect(t.scaled?.uiMultiplier).toBe(UI_MULTIPLIER_ONE);
  expect(t.scaled?.pending?.effectiveAt).toBe(farFuture);
});

test("interface id constants match BEP-677", () => {
  expect(SCALED_UI_AMOUNT_INTERFACE_ID).toBe("0xa60bf13d");
  expect(formatUnits(applyUiMultiplier(100n * 10n ** 18n, 105n * 10n ** 16n), 18)).toBe("105");
});

// ---------------------------------------------------------------------------
// Batching: a long token list is split into bounded chunks, each one
// multicall, at most CHUNK_CONCURRENCY in flight, results in input order.
// ---------------------------------------------------------------------------

const manyTokens = (n: number): Address[] =>
  Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address);

/** A multicall mock that answers each call from its own contracts list. */
function chunkAwareMulticall(o: { onStart?: () => void; onEnd?: () => void; delayMs?: number } = {}) {
  const sizes: number[] = [];
  const batchSizes: (number | undefined)[] = [];
  const multicall = mock(async (args: { contracts: { functionName: string; address: Address }[]; batchSize?: number }) => {
    sizes.push((args.contracts.length - 1) / 9);
    batchSizes.push(args.batchSize);
    o.onStart?.();
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    o.onEnd?.();
    return args.contracts.map((c, i) => {
      if (i === 0) return ok(BLOCK_TS);
      if (c.functionName === "balanceOf") return ok(BigInt(c.address));
      if (c.functionName === "decimals") return ok(0);
      if (c.functionName === "symbol") return ok("T");
      return fail();
    });
  });
  const client = { chain: bsc, multicall } as unknown as PublicClient;
  return { client, multicall, sizes, batchSizes };
}

test("100 tokens are read in 40/40/20 chunks with an explicit batchSize, order preserved", async () => {
  const tokens = manyTokens(100);
  const { client, sizes, batchSizes } = chunkAwareMulticall();
  const out = await readTokenBalances(client, OWNER, tokens);
  expect(sizes).toEqual([TOKENS_PER_CHUNK, TOKENS_PER_CHUNK, 100 - 2 * TOKENS_PER_CHUNK]);
  expect(batchSizes).toEqual([MULTICALL_BATCH_SIZE, MULTICALL_BATCH_SIZE, MULTICALL_BATCH_SIZE]);
  expect(out).toHaveLength(100);
  out.forEach((t, i) => {
    expect(t.address).toBe(tokens[i]!);
    if (!t.ok) throw new Error(t.error);
    expect(t.raw).toBe(BigInt(tokens[i]!));
  });
});

test("at most CHUNK_CONCURRENCY chunks are in flight; the next group waits for the previous", async () => {
  const tokens = manyTokens(TOKENS_PER_CHUNK * 5); // 5 chunks → groups of 3 + 2
  let inFlight = 0;
  let peak = 0;
  const starts: number[] = [];
  const { client, multicall } = chunkAwareMulticall({
    delayMs: 15,
    onStart: () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      starts.push(Date.now());
    },
    onEnd: () => {
      inFlight--;
    },
  });
  const out = await readTokenBalances(client, OWNER, tokens);
  expect(multicall).toHaveBeenCalledTimes(5);
  expect(peak).toBe(CHUNK_CONCURRENCY);
  // The 4th chunk starts only after the first group finished its delay.
  expect(starts[3]! - starts[0]!).toBeGreaterThanOrEqual(10);
  expect(out).toHaveLength(tokens.length);
});

test("chunk size keeps a chunk within one aggregate3 on the wire (one eth_call per chunk)", async () => {
  const tokens = manyTokens(TOKENS_PER_CHUNK * 2 + 5); // 3 chunks
  const posts: number[] = []; // inner calls per eth_call
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: [{ data: Hex }] }) => {
      if (req.method !== "eth_call") throw new Error(`unexpected ${req.method}`);
      const { args } = decodeFunctionData({ abi: multicall3Abi, data: req.params[0].data });
      const calls = args[0] as readonly unknown[];
      posts.push(calls.length);
      const result = encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: calls.map(() => ({ success: false, returnData: "0x" as Hex })),
      });
      return { jsonrpc: "2.0", id: req.id, result };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;

  const client = createPublicClient({ chain: bsc, transport: http("https://rpc.invalid") });
  const out = await readTokenBalances(client, OWNER, tokens);
  expect(posts).toEqual([
    1 + 9 * TOKENS_PER_CHUNK,
    1 + 9 * TOKENS_PER_CHUNK,
    1 + 9 * 5,
  ]);
  expect(out).toHaveLength(tokens.length);
  expect(out.every((t) => !t.ok)).toBe(true);
});
