/**
 * Uniswap v4 concentrated-liquidity arithmetic, as pure bigint.
 *
 * Ports of `TickMath.getSqrtPriceAtTick` (v4-core) and `LiquidityAmounts`
 * (v4-periphery), the two pieces an agent needs to turn "this much of each
 * token, in this tick range" into the `liquidity` figure the PositionManager
 * takes. No `@uniswap/*` dependency: those packages carry JSBI and their own
 * token model, and everything here is a few exact integer operations.
 *
 * All prices are `sqrtPriceX96`: sqrt(token1/token0) scaled by 2^96, the
 * chain's own representation (what `StateView.getSlot0` returns).
 */

/** Tick bounds — `TickMath.MIN_TICK` / `MAX_TICK`. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** `TickMath.MIN_SQRT_PRICE` / `MAX_SQRT_PRICE`: the prices at the tick bounds. */
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/** 2^96 — the fixed-point scale of sqrt prices. */
export const Q96 = 1n << 96n;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * The per-bit multipliers of `getSqrtPriceAtTick`: entry i is
 * sqrt(1.0001)^(-2^i) in Q128, for bits 0..19 of |tick|.
 */
const SQRT_RATIO_STEPS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/**
 * `TickMath.getSqrtPriceAtTick`: sqrt(1.0001^tick) * 2^96, rounded exactly as
 * the contract rounds it. Throws outside `[MIN_TICK, MAX_TICK]`.
 */
export function getSqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`uniswapV4: tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`);
  }
  const absTick = tick < 0 ? -tick : tick;

  let ratio = absTick & 1 ? SQRT_RATIO_STEPS[0]! : 1n << 128n;
  for (let i = 1; i < SQRT_RATIO_STEPS.length; i++) {
    if (absTick & (1 << i)) ratio = (ratio * SQRT_RATIO_STEPS[i]!) >> 128n;
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Q128 → Q96, rounding up: the contract's `(ratio >> 32) + (ratio % 2^32 == 0 ? 0 : 1)`.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * The closest tick to `tick` that the pool's `tickSpacing` allows, clamped to
 * the usable range. Mirrors `nearestUsableTick` from the Uniswap SDKs.
 */
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error(`uniswapV4: tickSpacing must be a positive integer (got ${tickSpacing})`);
  }
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return rounded + tickSpacing;
  if (rounded > MAX_TICK) return rounded - tickSpacing;
  return rounded;
}

function sortedPrices(a: bigint, b: bigint): [bigint, bigint] {
  return a > b ? [b, a] : [a, b];
}

function toUint128(x: bigint, what: string): bigint {
  if (x < 0n || x > MAX_UINT128) throw new Error(`uniswapV4: ${what} does not fit uint128`);
  return x;
}

/** `LiquidityAmounts.getLiquidityForAmount0` — liquidity `amount0` buys across [A, B]. */
export function getLiquidityForAmount0(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  amount0: bigint,
): bigint {
  const [lo, hi] = sortedPrices(sqrtPriceA, sqrtPriceB);
  const intermediate = (lo * hi) / Q96;
  return toUint128((amount0 * intermediate) / (hi - lo), "liquidity");
}

/** `LiquidityAmounts.getLiquidityForAmount1` — liquidity `amount1` buys across [A, B]. */
export function getLiquidityForAmount1(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  amount1: bigint,
): bigint {
  const [lo, hi] = sortedPrices(sqrtPriceA, sqrtPriceB);
  return toUint128((amount1 * Q96) / (hi - lo), "liquidity");
}

/**
 * `LiquidityAmounts.getLiquidityForAmounts`: the most liquidity `amount0` and
 * `amount1` can jointly fund in [A, B] at the current price. Below the range
 * only token0 counts, above it only token1, inside it the smaller of the two.
 */
export function getLiquidityForAmounts(
  sqrtPriceCurrent: bigint,
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const [lo, hi] = sortedPrices(sqrtPriceA, sqrtPriceB);
  if (sqrtPriceCurrent <= lo) return getLiquidityForAmount0(lo, hi, amount0);
  if (sqrtPriceCurrent < hi) {
    const l0 = getLiquidityForAmount0(sqrtPriceCurrent, hi, amount0);
    const l1 = getLiquidityForAmount1(lo, sqrtPriceCurrent, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(lo, hi, amount1);
}

/** `LiquidityAmounts.getAmount0ForLiquidity` (rounds down, like the library). */
export function getAmount0ForLiquidity(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
): bigint {
  const [lo, hi] = sortedPrices(sqrtPriceA, sqrtPriceB);
  return ((liquidity << 96n) * (hi - lo)) / hi / lo;
}

/** `LiquidityAmounts.getAmount1ForLiquidity` (rounds down, like the library). */
export function getAmount1ForLiquidity(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
): bigint {
  const [lo, hi] = sortedPrices(sqrtPriceA, sqrtPriceB);
  return (liquidity * (hi - lo)) / Q96;
}

/**
 * `LiquidityAmounts.getAmountsForLiquidity`: what a position of `liquidity`
 * in [A, B] holds of each token at the current price.
 */
export function getAmountsForLiquidity(
  sqrtPriceCurrent: bigint,
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const [lo, hi] = sortedPrices(sqrtPriceA, sqrtPriceB);
  if (sqrtPriceCurrent <= lo) {
    return { amount0: getAmount0ForLiquidity(lo, hi, liquidity), amount1: 0n };
  }
  if (sqrtPriceCurrent < hi) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceCurrent, hi, liquidity),
      amount1: getAmount1ForLiquidity(lo, sqrtPriceCurrent, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(lo, hi, liquidity) };
}
