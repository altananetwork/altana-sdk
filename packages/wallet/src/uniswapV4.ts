/**
 * Uniswap v4 liquidity — let an agent on an Altana wallet open, grow, collect
 * from, shrink and close concentrated-liquidity positions, in the user's own
 * wallet, within the caps of a session key.
 *
 * Every position change in v4 goes through ONE function on the
 * PositionManager, `modifyLiquidities(bytes unlockData, uint256 deadline)`,
 * whose payload is a small program: a byte string of actions (mint, settle,
 * take, sweep, ...) and one ABI-encoded parameter blob per action. This module
 * writes those programs. The layouts follow v4-periphery's `CalldataDecoder`,
 * which is what the chain executes, and the fork e2e drives them against the
 * real PositionManager on a BNB Chain fork.
 *
 * Why the session permission is one selector and not `{ to: positionManager }`:
 * the PositionManager is ALSO the ERC-721 that holds every LP position the
 * wallet owns. A contract-wide grant would let the session `transferFrom` the
 * positions away, `approve`/`setApprovalForAll` an operator that outlives the
 * session's revocation, or `permit` the same. Scoped to `modifyLiquidities`,
 * the session can manage liquidity and nothing else on that contract.
 *
 * What the selector does not bound: the arguments. The agent chooses the pool,
 * the `owner` of a minted position and the recipient of `TAKE`d tokens. Value
 * leaving the wallet is capped by the session's per-token spend limits and its
 * expiry — set a cap for every currency in the pair, native included.
 *
 * Token flow. ERC-20s are pulled by the PositionManager through Permit2, so a
 * pair's ERC-20s need a one-time admin setup (`approveUniswapV4Pair`): the
 * token approves Permit2, and Permit2 approves the PositionManager. The native
 * currency (ETH / BNB) needs no approval; it rides as `value` and any excess
 * is swept back to the wallet in the same call.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint160,
  pad,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { type NetworkConfig } from "./config.js";
import { buildApproveTokenForPermit2Call } from "./approveTokenForPermit2.js";
import { execute, executeWithReceipts, type ExecuteOptions } from "./execute.js";
import { buildPublicClient, type Call, type RelayLog } from "./internal/relay.js";
import type { CallPermission, Session } from "./internal/sessions.js";
import type { Signer } from "./internal/signer.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";
import { PERMIT2_ADDRESS } from "./x402.js";

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export type UniswapV4Addresses = {
  /** The one contract a liquidity session is scoped to; also the LP ERC-721. */
  positionManager: Address;
  poolManager: Address;
  /** Read-only lens over PoolManager storage (slot0, liquidity). */
  stateView: Address;
  permit2: Address;
};

/** Canonical Uniswap v4 deployments (developers.uniswap.org/docs/protocols/v4/deployments). */
export const UNISWAP_V4_ADDRESSES: Record<number, UniswapV4Addresses> = {
  1: {
    positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
    poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    permit2: PERMIT2_ADDRESS,
  },
  56: {
    positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
    poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
    permit2: PERMIT2_ADDRESS,
  },
  8453: {
    positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
    permit2: PERMIT2_ADDRESS,
  },
};

export function uniswapV4Addresses(chainId: number): UniswapV4Addresses {
  const addresses = UNISWAP_V4_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(
      `uniswapV4: no deployment registered for chainId ${chainId} (known: ${Object.keys(UNISWAP_V4_ADDRESSES).join(", ")}).`,
    );
  }
  return addresses;
}

/** v4 addresses the native currency (ETH, BNB) as the zero address. */
export const NATIVE_CURRENCY: Address = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/** A v4 pool is identified by its key, not by a contract of its own. */
export type PoolKey = {
  /** The numerically lower currency address (native = zero address). */
  currency0: Address;
  currency1: Address;
  /** Fee in hundredths of a bip (500 = 0.05%). */
  fee: number;
  tickSpacing: number;
  /** Zero address for a hookless pool. */
  hooks: Address;
};

/** v4 orders a pair by address; the native currency (zero) always sorts first. */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/** `PoolId.toId(key)` — keccak256 of the ABI-encoded key. */
export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "tuple", components: POOL_KEY_COMPONENTS }], [key]),
  );
}

// ---------------------------------------------------------------------------
// The program: actions + params
// ---------------------------------------------------------------------------

/** v4-periphery `Actions` — one byte per step of a `modifyLiquidities` program. */
export const V4_ACTIONS = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  SWEEP: 0x14,
} as const;

const MODIFY_LIQUIDITIES_SIGNATURE = "modifyLiquidities(bytes,uint256)";

const POSITION_MANAGER_ABI = [
  {
    name: "modifyLiquidities",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "getPoolAndPositionInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
      { name: "info", type: "uint256" },
    ],
  },
  {
    name: "getPositionLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { name: "nextTokenId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const STATE_VIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    name: "getLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

const ERC721_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
  ],
} as const;
const ERC721_TRANSFER_TOPIC = toEventSelector(ERC721_TRANSFER_EVENT);

/** `abi.encode(bytes actions, bytes[] params)` — the `unlockData` argument. */
export function encodeUnlockData(actions: readonly number[], params: readonly Hex[]): Hex {
  if (actions.length !== params.length) {
    throw new Error(`uniswapV4: ${actions.length} action(s) but ${params.length} param blob(s)`);
  }
  const actionBytes = ("0x" +
    actions.map((a) => a.toString(16).padStart(2, "0")).join("")) as Hex;
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actionBytes, params]);
}

// Per-action parameter layouts, from v4-periphery `CalldataDecoder`.
const encodeMintParams = (p: {
  poolKey: PoolKey; tickLower: number; tickUpper: number; liquidity: bigint;
  amount0Max: bigint; amount1Max: bigint; owner: Address; hookData: Hex;
}) =>
  encodeAbiParameters(
    [
      { type: "tuple", components: POOL_KEY_COMPONENTS },
      { type: "int24" }, { type: "int24" }, { type: "uint256" },
      { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" },
    ],
    [p.poolKey, p.tickLower, p.tickUpper, p.liquidity, p.amount0Max, p.amount1Max, p.owner, p.hookData],
  );
const encodeModifyParams = (tokenId: bigint, liquidity: bigint, amount0: bigint, amount1: bigint, hookData: Hex) =>
  encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [tokenId, liquidity, amount0, amount1, hookData],
  );
const encodeBurnParams = (tokenId: bigint, amount0Min: bigint, amount1Min: bigint, hookData: Hex) =>
  encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [tokenId, amount0Min, amount1Min, hookData],
  );
const encodeCurrencyPair = (c0: Address, c1: Address) =>
  encodeAbiParameters([{ type: "address" }, { type: "address" }], [c0, c1]);
const encodeCurrencyPairAndAddress = (c0: Address, c1: Address, to: Address) =>
  encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [c0, c1, to]);
const encodeCurrencyAndAddress = (c: Address, to: Address) =>
  encodeAbiParameters([{ type: "address" }, { type: "address" }], [c, to]);

/** Default deadline: 20 minutes from now, absolute unix seconds. */
function defaultDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
}

/** Wrap a program in the one call a liquidity session may make. */
export function buildModifyLiquiditiesCall(
  chainId: number,
  unlockData: Hex,
  deadline: bigint,
  value: bigint = 0n,
): Call {
  return {
    to: uniswapV4Addresses(chainId).positionManager,
    value,
    data: encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: "modifyLiquidities",
      args: [unlockData, deadline],
    }),
  };
}

// ---------------------------------------------------------------------------
// Call builders — the unit-testable seam
// ---------------------------------------------------------------------------

export type MintPositionInput = {
  chainId: number;
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  /** From `getLiquidityForAmounts` — the position size in v4's own unit. */
  liquidity: bigint;
  /** Slippage bounds: the most of each currency the mint may take. */
  amount0Max: bigint;
  amount1Max: bigint;
  /** Who receives the LP NFT. The wallet itself, unless you mean otherwise. */
  owner: Address;
  /** Absolute unix seconds; defaults to 20 minutes from now. */
  deadline?: bigint;
  hookData?: Hex;
};

/**
 * `MINT_POSITION, SETTLE_PAIR, SWEEP(currency0), SWEEP(currency1)`: mint the
 * position, pay what it took from the wallet, and return any excess. When
 * currency0 is native, `amount0Max` rides as `value` and the sweep refunds
 * what the mint did not need.
 */
export function buildMintPositionCall(input: MintPositionInput): Call {
  assertRange(input.tickLower, input.tickUpper, input.poolKey.tickSpacing);
  const { currency0, currency1 } = input.poolKey;
  const unlockData = encodeUnlockData(
    [V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR, V4_ACTIONS.SWEEP, V4_ACTIONS.SWEEP],
    [
      encodeMintParams({
        poolKey: input.poolKey,
        tickLower: input.tickLower,
        tickUpper: input.tickUpper,
        liquidity: input.liquidity,
        amount0Max: input.amount0Max,
        amount1Max: input.amount1Max,
        owner: input.owner,
        hookData: input.hookData ?? "0x",
      }),
      encodeCurrencyPair(currency0, currency1),
      encodeCurrencyAndAddress(currency0, input.owner),
      encodeCurrencyAndAddress(currency1, input.owner),
    ],
  );
  const value = currency0 === NATIVE_CURRENCY ? input.amount0Max : 0n;
  return buildModifyLiquiditiesCall(input.chainId, unlockData, input.deadline ?? defaultDeadline(), value);
}

export type IncreaseLiquidityInput = {
  chainId: number;
  /** The pool the position is in — needed to settle and sweep the right pair. */
  poolKey: PoolKey;
  tokenId: bigint;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  /** Where excess is swept: the wallet. */
  wallet: Address;
  deadline?: bigint;
  hookData?: Hex;
};

/** `INCREASE_LIQUIDITY, SETTLE_PAIR, SWEEP, SWEEP` — add to an existing position. */
export function buildIncreaseLiquidityCall(input: IncreaseLiquidityInput): Call {
  const { currency0, currency1 } = input.poolKey;
  const unlockData = encodeUnlockData(
    [V4_ACTIONS.INCREASE_LIQUIDITY, V4_ACTIONS.SETTLE_PAIR, V4_ACTIONS.SWEEP, V4_ACTIONS.SWEEP],
    [
      encodeModifyParams(input.tokenId, input.liquidity, input.amount0Max, input.amount1Max, input.hookData ?? "0x"),
      encodeCurrencyPair(currency0, currency1),
      encodeCurrencyAndAddress(currency0, input.wallet),
      encodeCurrencyAndAddress(currency1, input.wallet),
    ],
  );
  const value = currency0 === NATIVE_CURRENCY ? input.amount0Max : 0n;
  return buildModifyLiquiditiesCall(input.chainId, unlockData, input.deadline ?? defaultDeadline(), value);
}

export type DecreaseLiquidityInput = {
  chainId: number;
  poolKey: PoolKey;
  tokenId: bigint;
  /** How much to remove. `0n` collects accrued fees without touching principal. */
  liquidity: bigint;
  /** Slippage floors: the least of each currency the removal must yield. */
  amount0Min: bigint;
  amount1Min: bigint;
  /** Who receives the withdrawn tokens (and fees). The wallet, normally. */
  recipient: Address;
  deadline?: bigint;
  hookData?: Hex;
};

/** `DECREASE_LIQUIDITY, TAKE_PAIR(recipient)` — remove liquidity and/or collect fees. */
export function buildDecreaseLiquidityCall(input: DecreaseLiquidityInput): Call {
  const { currency0, currency1 } = input.poolKey;
  const unlockData = encodeUnlockData(
    [V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR],
    [
      encodeModifyParams(input.tokenId, input.liquidity, input.amount0Min, input.amount1Min, input.hookData ?? "0x"),
      encodeCurrencyPairAndAddress(currency0, currency1, input.recipient),
    ],
  );
  return buildModifyLiquiditiesCall(input.chainId, unlockData, input.deadline ?? defaultDeadline());
}

/** Collect a position's accrued fees: a decrease of zero liquidity. */
export function buildCollectFeesCall(
  input: Omit<DecreaseLiquidityInput, "liquidity" | "amount0Min" | "amount1Min">,
): Call {
  return buildDecreaseLiquidityCall({ ...input, liquidity: 0n, amount0Min: 0n, amount1Min: 0n });
}

export type BurnPositionInput = {
  chainId: number;
  poolKey: PoolKey;
  tokenId: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
  deadline?: bigint;
  hookData?: Hex;
};

/**
 * `BURN_POSITION, TAKE_PAIR(recipient)` — close the position: withdraw all of
 * its liquidity and fees and burn the NFT.
 */
export function buildBurnPositionCall(input: BurnPositionInput): Call {
  const { currency0, currency1 } = input.poolKey;
  const unlockData = encodeUnlockData(
    [V4_ACTIONS.BURN_POSITION, V4_ACTIONS.TAKE_PAIR],
    [
      encodeBurnParams(input.tokenId, input.amount0Min, input.amount1Min, input.hookData ?? "0x"),
      encodeCurrencyPairAndAddress(currency0, currency1, input.recipient),
    ],
  );
  return buildModifyLiquiditiesCall(input.chainId, unlockData, input.deadline ?? defaultDeadline());
}

/**
 * `Permit2.approve(token, positionManager, amount, expiration)` — the second
 * half of the ERC-20 setup (the first is the token approving Permit2, see
 * `buildApproveTokenForPermit2Call`). Defaults to the maximum amount and the
 * maximum expiration, the usual standing allowance; the session's own spend
 * caps are what bound the agent.
 */
export function buildPermit2ApproveCall(input: {
  chainId: number;
  token: Address;
  amount?: bigint;
  /** Unix seconds; defaults to the uint48 maximum (never expires). */
  expiration?: number;
}): Call {
  const { positionManager, permit2 } = uniswapV4Addresses(input.chainId);
  return {
    to: permit2,
    value: 0n,
    data: encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: "approve",
      args: [input.token, positionManager, input.amount ?? maxUint160, input.expiration ?? 2 ** 48 - 1],
    }),
  };
}

function assertRange(tickLower: number, tickUpper: number, tickSpacing: number) {
  if (tickLower >= tickUpper) {
    throw new Error(`uniswapV4: tickLower (${tickLower}) must be below tickUpper (${tickUpper})`);
  }
  if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
    throw new Error(
      `uniswapV4: ticks must be multiples of the pool's tickSpacing ${tickSpacing} ` +
        `(got ${tickLower}, ${tickUpper}); see nearestUsableTick`,
    );
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * The bounded capability: exactly `modifyLiquidities` on the PositionManager.
 *
 * Pass straight into `grantSession({ permissions: { calls:
 * uniswapV4LiquidityPermissions(chainId), spend: [...] } })`, with a spend cap
 * for every currency in the pair (native included — it also pays relay fees).
 * See the module header for why this is not a `{ to: positionManager }` grant.
 */
export function uniswapV4LiquidityPermissions(chainId: number): CallPermission[] {
  return [
    { to: uniswapV4Addresses(chainId).positionManager, signature: MODIFY_LIQUIDITIES_SIGNATURE },
  ];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type PoolState = {
  sqrtPriceX96: bigint;
  tick: number;
  /** Currently active liquidity in the pool. */
  liquidity: bigint;
  /** The pool's LP fee in hundredths of a bip (dynamic-fee pools can differ from the key). */
  lpFee: number;
};

/** Price and liquidity of a pool, via StateView. Throws if the pool was never initialized. */
export async function readUniswapV4Pool(network: NetworkConfig, poolKey: PoolKey): Promise<PoolState> {
  const publicClient = buildPublicClient(network);
  const { stateView } = uniswapV4Addresses(network.chainId);
  const id = poolId(poolKey);
  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [id] }),
    publicClient.readContract({ address: stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [id] }),
  ]);
  const [sqrtPriceX96, tick, , lpFee] = slot0;
  if (sqrtPriceX96 === 0n) {
    throw new Error(`uniswapV4: pool ${id} is not initialized on chain ${network.chainId}`);
  }
  return { sqrtPriceX96, tick, liquidity, lpFee };
}

export type PositionState = {
  tokenId: bigint;
  owner: Address;
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
};

/**
 * Unpack the PositionManager's `PositionInfo` word:
 * `200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber`.
 */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean } {
  const int24 = (x: bigint) => {
    const v = Number(x & 0xffffffn);
    return v >= 0x800000 ? v - 0x1000000 : v;
  };
  return {
    tickLower: int24(info >> 8n),
    tickUpper: int24(info >> 32n),
    hasSubscriber: (info & 0xffn) !== 0n,
  };
}

/** Owner, pool, range and liquidity of an LP position. */
export async function readUniswapV4Position(network: NetworkConfig, tokenId: bigint): Promise<PositionState> {
  const publicClient = buildPublicClient(network);
  const { positionManager } = uniswapV4Addresses(network.chainId);
  const [[poolKey, info], liquidity, owner] = await Promise.all([
    publicClient.readContract({ address: positionManager, abi: POSITION_MANAGER_ABI, functionName: "getPoolAndPositionInfo", args: [tokenId] }),
    publicClient.readContract({ address: positionManager, abi: POSITION_MANAGER_ABI, functionName: "getPositionLiquidity", args: [tokenId] }),
    publicClient.readContract({ address: positionManager, abi: POSITION_MANAGER_ABI, functionName: "ownerOf", args: [tokenId] }),
  ]);
  const { tickLower, tickUpper } = decodePositionInfo(info);
  return { tokenId, owner, poolKey: { ...poolKey }, tickLower, tickUpper, liquidity };
}

/**
 * The tokenId the PositionManager minted to `owner` in this receipt: the
 * ERC-721 `Transfer(0x0 → owner, tokenId)` emitted by that contract. Both
 * filters matter — a relay receipt can bundle other wallets' intents, and
 * other contracts emit the same topic.
 */
export function findMintedTokenId(
  logs: readonly RelayLog[],
  positionManager: Address,
  owner: Address,
): bigint | undefined {
  const pmLower = positionManager.toLowerCase();
  const zeroTopic = pad("0x0", { size: 32 });
  const ownerTopic = pad(owner.toLowerCase() as Hex, { size: 32 });
  for (const log of logs) {
    if (log.address?.toLowerCase() !== pmLower) continue;
    if (log.topics?.[0]?.toLowerCase() !== ERC721_TRANSFER_TOPIC.toLowerCase()) continue;
    if (log.topics?.[1]?.toLowerCase() !== zeroTopic) continue;
    if (log.topics?.[2]?.toLowerCase() !== ownerTopic) continue;
    const tokenIdTopic = log.topics[3];
    if (!tokenIdTopic) continue;
    return BigInt(tokenIdTopic);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Params for `mintUniswapV4Position`: the builder's input minus what the wallet supplies. */
export type MintPositionParams = Omit<MintPositionInput, "chainId" | "owner"> & {
  /** Defaults to the wallet. */
  owner?: Address;
};
export type MintPositionResult = ExecuteResult & { tokenId: bigint };

/**
 * Open a position and return its tokenId, read from the relay's receipt (so
 * `opts.noWait` is rejected). Admin path (wallet + signer) or session path.
 */
export function mintUniswapV4Position(
  wallet: Wallet, signer: Signer, params: MintPositionParams, opts: ExecuteOptions,
): Promise<MintPositionResult>;
export function mintUniswapV4Position(
  session: Session, params: MintPositionParams, opts: ExecuteOptions,
): Promise<MintPositionResult>;
export async function mintUniswapV4Position(
  walletOrSession: Wallet | Session,
  signerOrParams: Signer | MintPositionParams,
  paramsOrOpts?: MintPositionParams | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<MintPositionResult> {
  const isSessionCall = "walletAddress" in walletOrSession;
  const params = (isSessionCall ? signerOrParams : paramsOrOpts) as MintPositionParams;
  const opts = (isSessionCall ? paramsOrOpts : maybeOpts) as ExecuteOptions;
  const walletAddress = isSessionCall
    ? (walletOrSession as Session).walletAddress
    : (walletOrSession as Wallet).address;

  if (opts.noWait) {
    throw new Error("uniswapV4: mint needs a confirmed receipt to recover the tokenId — do not pass noWait");
  }

  const chainId = opts.network.chainId;
  const owner = params.owner ?? walletAddress;
  const call = buildMintPositionCall({ ...params, chainId, owner });

  const result = isSessionCall
    ? await executeWithReceipts(walletOrSession as Session, call, opts)
    : await executeWithReceipts(walletOrSession as Wallet, signerOrParams as Signer, call, opts);
  const { receipts, ...executeResult } = result;

  if (executeResult.status === "FAILED") {
    const code = executeResult.statusCode;
    if (code !== undefined && code < 500) {
      throw new Error(
        `uniswapV4: the relay rejected the mint before inclusion (relay code ${code}, callsId ` +
          `${executeResult.callsId}). Common causes: a spend cap that cannot cover the amounts plus ` +
          `the relay fee, or a relay policy refused the bundle.`,
      );
    }
    throw new Error(
      `uniswapV4: mint reverted (callsId ${executeResult.callsId}${
        executeResult.transactionHash ? `, tx ${executeResult.transactionHash}` : ""
      }). Check the pool is initialized, the ERC-20 side is approved through Permit2 ` +
        `(approveUniswapV4Pair), the ticks fit the pool's spacing, and a session key holds ` +
        `uniswapV4LiquidityPermissions(${chainId}).`,
    );
  }
  if (executeResult.status !== "CONFIRMED") {
    throw new Error(
      `uniswapV4: mint did not confirm within the relay wait (status ${executeResult.status}, ` +
        `callsId ${executeResult.callsId}). It may still land — recover the tokenId from that ` +
        `callsId's receipt rather than minting again.`,
    );
  }

  const logs = (receipts ?? []).flatMap((r) => r.logs ?? []);
  const tokenId = findMintedTokenId(logs, uniswapV4Addresses(chainId).positionManager, owner);
  if (tokenId === undefined) {
    throw new Error(
      `uniswapV4: mint confirmed but no Transfer to ${owner} from the PositionManager was found ` +
        `in the relay's receipt (tx ${executeResult.transactionHash ?? "unknown"}, ${logs.length} log(s)).`,
    );
  }
  return { ...executeResult, tokenId };
}

type SessionOrAdmin<P> =
  | [wallet: Wallet, signer: Signer, params: P, opts: ExecuteOptions]
  | [session: Session, params: P, opts: ExecuteOptions];

function runCall<P>(
  args: SessionOrAdmin<P>,
  build: (params: P, chainId: number, wallet: Address) => Call,
): Promise<ExecuteResult> {
  if ("walletAddress" in args[0]) {
    const [session, params, opts] = args as [Session, P, ExecuteOptions];
    return execute(session, build(params, opts.network.chainId, session.walletAddress), opts);
  }
  const [wallet, signer, params, opts] = args as [Wallet, Signer, P, ExecuteOptions];
  return execute(wallet, signer, build(params, opts.network.chainId, wallet.address), opts);
}

export type IncreaseLiquidityParams = Omit<IncreaseLiquidityInput, "chainId" | "wallet">;
export type DecreaseLiquidityParams = Omit<DecreaseLiquidityInput, "chainId" | "recipient"> & {
  /** Defaults to the wallet. */
  recipient?: Address;
};
export type CollectFeesParams = Omit<DecreaseLiquidityParams, "liquidity" | "amount0Min" | "amount1Min">;
export type BurnPositionParams = Omit<BurnPositionInput, "chainId" | "recipient"> & {
  recipient?: Address;
};

/** Add liquidity to a position the wallet owns. */
export function increaseUniswapV4Liquidity(wallet: Wallet, signer: Signer, params: IncreaseLiquidityParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function increaseUniswapV4Liquidity(session: Session, params: IncreaseLiquidityParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function increaseUniswapV4Liquidity(...args: SessionOrAdmin<IncreaseLiquidityParams>): Promise<ExecuteResult> {
  return runCall(args, (p, chainId, wallet) => buildIncreaseLiquidityCall({ ...p, chainId, wallet }));
}

/** Remove some or all liquidity (fees come along) to `recipient`, the wallet by default. */
export function decreaseUniswapV4Liquidity(wallet: Wallet, signer: Signer, params: DecreaseLiquidityParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function decreaseUniswapV4Liquidity(session: Session, params: DecreaseLiquidityParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function decreaseUniswapV4Liquidity(...args: SessionOrAdmin<DecreaseLiquidityParams>): Promise<ExecuteResult> {
  return runCall(args, (p, chainId, wallet) =>
    buildDecreaseLiquidityCall({ ...p, chainId, recipient: p.recipient ?? wallet }),
  );
}

/** Collect accrued fees without touching principal. */
export function collectUniswapV4Fees(wallet: Wallet, signer: Signer, params: CollectFeesParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function collectUniswapV4Fees(session: Session, params: CollectFeesParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function collectUniswapV4Fees(...args: SessionOrAdmin<CollectFeesParams>): Promise<ExecuteResult> {
  return runCall(args, (p, chainId, wallet) =>
    buildCollectFeesCall({ ...p, chainId, recipient: p.recipient ?? wallet }),
  );
}

/** Close a position entirely and burn its NFT. */
export function burnUniswapV4Position(wallet: Wallet, signer: Signer, params: BurnPositionParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function burnUniswapV4Position(session: Session, params: BurnPositionParams, opts: ExecuteOptions): Promise<ExecuteResult>;
export function burnUniswapV4Position(...args: SessionOrAdmin<BurnPositionParams>): Promise<ExecuteResult> {
  return runCall(args, (p, chainId, wallet) =>
    buildBurnPositionCall({ ...p, chainId, recipient: p.recipient ?? wallet }),
  );
}

/**
 * One-time admin setup for a pair's ERC-20s: each token approves Permit2, and
 * Permit2 approves the PositionManager. One atomic intent. The native
 * currency needs nothing and is skipped if listed.
 */
export function approveUniswapV4Pair(
  wallet: Wallet,
  adminSigner: Signer,
  params: { tokens: readonly Address[]; amount?: bigint; expiration?: number },
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const chainId = opts.network.chainId;
  const calls: Call[] = [];
  for (const token of params.tokens) {
    if (token === NATIVE_CURRENCY) continue;
    calls.push(buildApproveTokenForPermit2Call(token));
    calls.push(buildPermit2ApproveCall({ chainId, token, amount: params.amount, expiration: params.expiration }));
  }
  if (calls.length === 0) {
    throw new Error("uniswapV4: approveUniswapV4Pair needs at least one ERC-20 (the native currency needs no approval)");
  }
  return execute(wallet, adminSigner, calls, opts);
}
