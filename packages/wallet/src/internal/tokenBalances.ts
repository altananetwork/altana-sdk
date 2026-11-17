import {
  formatUnits,
  hexToString,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { TokenBalance } from "../balances.js";

/** BEP-677 IScaledUIAmount ERC-165 interface id. */
export const SCALED_UI_AMOUNT_INTERFACE_ID = "0xa60bf13d" as const;
/** BEP-677 IScaledUIAmountNewUIMultiplier ERC-165 interface id. */
export const SCALED_UI_AMOUNT_PENDING_INTERFACE_ID = "0x4bd27648" as const;
/** Fixed-point one for uiMultiplier (1e18 = 1.0x). */
export const UI_MULTIPLIER_ONE = 10n ** 18n;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

// Some older tokens (MKR-style) declare symbol() as bytes32 instead of string.
const ERC20_SYMBOL_BYTES32_ABI = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const ERC165_ABI = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const SCALED_UI_AMOUNT_ABI = [
  {
    type: "function",
    name: "uiMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const SCALED_UI_AMOUNT_PENDING_ABI = [
  {
    type: "function",
    name: "newUIMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "effectiveAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const MULTICALL3_TIMESTAMP_ABI = [
  {
    type: "function",
    name: "getCurrentBlockTimestamp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** raw * multiplier / 1e18, integer truncation (the BEP-677 display formula). */
export function applyUiMultiplier(raw: bigint, uiMultiplier: bigint): bigint {
  return (raw * uiMultiplier) / UI_MULTIPLIER_ONE;
}

type ReadCall = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

type ReadResult = { status: "success" | "failure"; result?: unknown };

const CALLS_PER_TOKEN = 9;

/**
 * Calldata budget per aggregate3 call, in bytes of inner calldata (viem's
 * `batchSize` unit). One token row is 132 bytes (two 36-byte calls with an
 * argument, seven 4-byte selector-only calls), so 6 KB fits ~46 tokens —
 * comfortably inside what public RPCs accept for a single eth_call.
 */
export const MULTICALL_BATCH_SIZE = 6_144;
/**
 * Tokens per chunk. Sized so a chunk (header + rows) stays under
 * MULTICALL_BATCH_SIZE and therefore maps to exactly one aggregate3 call;
 * viem would otherwise split it and fire the pieces all at once.
 */
export const TOKENS_PER_CHUNK = 40;
/** Chunks in flight at once against the public RPC. */
export const CHUNK_CONCURRENCY = 3;

/**
 * Executes the reads via multicall3 when the chain supports it, otherwise
 * degrades to individual eth_calls. Both paths yield the same result shape.
 */
async function safeReads(
  publicClient: PublicClient,
  calls: ReadCall[],
): Promise<ReadResult[]> {
  if (publicClient.chain?.contracts?.multicall3) {
    return (await publicClient.multicall({
      contracts: calls as never,
      allowFailure: true,
      batchSize: MULTICALL_BATCH_SIZE,
    })) as ReadResult[];
  }
  return Promise.all(
    calls.map(async (call): Promise<ReadResult> => {
      try {
        const result = await publicClient.readContract(call as never);
        return { status: "success", result };
      } catch {
        return { status: "failure" };
      }
    }),
  );
}

function success(r: ReadResult | undefined): r is ReadResult & { status: "success" } {
  return r?.status === "success";
}

function decodeBytes32Symbol(value: Hex): string {
  const s = hexToString(value);
  const end = s.indexOf("\u0000");
  return end === -1 ? s : s.slice(0, end);
}

/**
 * Reads ERC-20 balances for `tokens`, applying the BEP-677 scaled-UI-amount
 * multiplier to the display value when a token advertises IScaledUIAmount via
 * ERC-165. Raw amounts are always returned unscaled — they are what transfers
 * and allowances operate on; only `display`/`scaledRaw` carry the multiplier.
 *
 * All per-token reads are batched into a single speculative multicall with
 * allowFailure. BEP-677 results are only interpreted when the corresponding
 * supportsInterface call returned true, per the spec's detection requirement.
 * A token whose balanceOf or decimals read fails yields `{ ok: false }`
 * rather than throwing; input order is preserved.
 */
export async function readTokenBalances(
  publicClient: PublicClient,
  owner: Address,
  tokens: readonly Address[],
): Promise<TokenBalance[]> {
  if (tokens.length === 0) return [];

  // Chunk the token list so each multicall is one bounded aggregate3, and run
  // at most CHUNK_CONCURRENCY chunks at a time: a wallet holding hundreds of
  // tokens must not turn into a burst of parallel eth_calls against a public
  // endpoint. Results are concatenated in input order.
  const chunks: Address[][] = [];
  for (let i = 0; i < tokens.length; i += TOKENS_PER_CHUNK) {
    chunks.push(tokens.slice(i, i + TOKENS_PER_CHUNK));
  }
  const out: TokenBalance[] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const group = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const results = await Promise.all(
      group.map((chunk) => readTokenChunk(publicClient, owner, chunk)),
    );
    for (const r of results) out.push(...r);
  }
  return out;
}

/** One chunk: a single speculative multicall (header + 9 calls per token). */
async function readTokenChunk(
  publicClient: PublicClient,
  owner: Address,
  tokens: readonly Address[],
): Promise<TokenBalance[]> {
  const multicall3 = publicClient.chain?.contracts?.multicall3?.address;
  const calls: ReadCall[] = [
    // Header: block timestamp atomic with the reads, so pending-multiplier
    // comparisons can't race a multiplier flip between read and wall clock.
    multicall3
      ? {
          address: multicall3,
          abi: MULTICALL3_TIMESTAMP_ABI,
          functionName: "getCurrentBlockTimestamp",
        }
      : // No multicall3 on this chain: keep positions aligned with a call
        // that will fail against a token-less address; wall clock is used.
        {
          address: "0x0000000000000000000000000000000000000000",
          abi: MULTICALL3_TIMESTAMP_ABI,
          functionName: "getCurrentBlockTimestamp",
        },
  ];

  for (const token of tokens) {
    calls.push(
      { address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] },
      { address: token, abi: ERC20_ABI, functionName: "decimals" },
      { address: token, abi: ERC20_ABI, functionName: "symbol" },
      { address: token, abi: ERC20_SYMBOL_BYTES32_ABI, functionName: "symbol" },
      {
        address: token,
        abi: ERC165_ABI,
        functionName: "supportsInterface",
        args: [SCALED_UI_AMOUNT_INTERFACE_ID],
      },
      {
        address: token,
        abi: ERC165_ABI,
        functionName: "supportsInterface",
        args: [SCALED_UI_AMOUNT_PENDING_INTERFACE_ID],
      },
      { address: token, abi: SCALED_UI_AMOUNT_ABI, functionName: "uiMultiplier" },
      {
        address: token,
        abi: SCALED_UI_AMOUNT_PENDING_ABI,
        functionName: "newUIMultiplier",
      },
      { address: token, abi: SCALED_UI_AMOUNT_PENDING_ABI, functionName: "effectiveAt" },
    );
  }

  const results = await safeReads(publicClient, calls);

  const tsResult = results[0];
  const blockTs = success(tsResult)
    ? (tsResult.result as bigint)
    : BigInt(Math.floor(Date.now() / 1000));

  return tokens.map((address, i) => {
    const at = (offset: number) => results[1 + i * CALLS_PER_TOKEN + offset];
    const [balance, decimals, symbolStr, symbolB32, supportsScaled, supportsPending, uiMultiplier, newUIMultiplier, effectiveAt] =
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map(at);

    if (!success(balance) || !success(decimals)) {
      const failed = !success(balance) ? "balanceOf" : "decimals";
      return { address, ok: false as const, error: `${failed}() read failed` };
    }

    const raw = balance.result as bigint;
    const dec = Number(decimals.result);
    const symbol = success(symbolStr)
      ? (symbolStr.result as string)
      : success(symbolB32)
        ? decodeBytes32Symbol(symbolB32.result as Hex)
        : "";

    const isScaled = success(supportsScaled) && supportsScaled.result === true && success(uiMultiplier);
    if (!isScaled) {
      return { address, ok: true as const, raw, decimals: dec, symbol, display: formatUnits(raw, dec) };
    }

    let effective = uiMultiplier.result as bigint;
    let pending: { newUIMultiplier: bigint; effectiveAt: bigint } | undefined;

    const hasPendingIface =
      success(supportsPending) && supportsPending.result === true &&
      success(newUIMultiplier) && success(effectiveAt);
    if (hasPendingIface) {
      const effAt = effectiveAt.result as bigint;
      const newMult = newUIMultiplier.result as bigint;
      if (effAt > blockTs) {
        pending = { newUIMultiplier: newMult, effectiveAt: effAt };
      } else if (effAt !== 0n) {
        // Change already in effect. A compliant token's uiMultiplier() has
        // switched over on-chain; prefer newUIMultiplier to guard lazy ones.
        effective = newMult;
      }
    }

    const scaledRaw = applyUiMultiplier(raw, effective);
    return {
      address,
      ok: true as const,
      raw,
      decimals: dec,
      symbol,
      display: formatUnits(scaledRaw, dec),
      scaled: {
        uiMultiplier: effective,
        scaledRaw,
        ...(pending ? { pending } : {}),
      },
    };
  });
}
