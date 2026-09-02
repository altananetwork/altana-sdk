/**
 * Concentrated-liquidity math against independently computed vectors.
 *
 * The tick → price vectors were produced with Python's Decimal at 80 digits
 * (sqrt(1.0001^tick) * 2^96); the contract's bit-decomposition rounds within
 * a few units of that, so those compare at 1 part in 10^12. The bounds and
 * tick 0 are exact: they are the contract's own MIN/MAX_SQRT_PRICE constants
 * and 2^96. The liquidity/amount vectors are the ones from Uniswap's
 * LiquidityAmounts test-suite (1:1 price, a 100/110 ↔ 110/100 range).
 */
import { test, expect, describe } from "bun:test";
import {
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  Q96,
  getSqrtPriceAtTick,
  nearestUsableTick,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getLiquidityForAmounts,
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
} from "./uniswapV4Math.js";

function expectClose(actual: bigint, expected: bigint) {
  const diff = actual > expected ? actual - expected : expected - actual;
  expect(diff <= expected / 1_000_000_000_000n + 1n).toBe(true);
}

describe("getSqrtPriceAtTick", () => {
  test("exact at the bounds and at tick 0", () => {
    expect(getSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE);
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE);
    expect(getSqrtPriceAtTick(0)).toBe(Q96);
  });

  test("matches high-precision sqrt(1.0001^tick) * 2^96", () => {
    const vectors: [number, bigint][] = [
      [-100000, 533968626430936354154228407n],
      [-887, 75791340164260940293635632489n],
      [-50, 79030349367926598376800521321n],
      [-1, 79224201403219477170569942573n],
      [1, 79232123823359799118286999567n],
      [50, 79426470787362580746886972460n],
      [887, 82820830477234645458774459180n],
      [100000, 11755562826496067164730007768449n],
    ];
    for (const [tick, expected] of vectors) expectClose(getSqrtPriceAtTick(tick), expected);
  });

  test("is monotonic and symmetric around 0", () => {
    let prev = getSqrtPriceAtTick(-1000);
    for (let t = -999; t <= 1000; t += 7) {
      const cur = getSqrtPriceAtTick(t);
      expect(cur > prev).toBe(true);
      prev = cur;
    }
    // price(t) * price(-t) ≈ 2^192
    const p = getSqrtPriceAtTick(500) * getSqrtPriceAtTick(-500);
    expectClose(p, Q96 * Q96);
  });

  test("rejects out-of-range and non-integer ticks", () => {
    expect(() => getSqrtPriceAtTick(MIN_TICK - 1)).toThrow(/outside/);
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow(/outside/);
    expect(() => getSqrtPriceAtTick(1.5)).toThrow(/outside/);
  });
});

describe("nearestUsableTick", () => {
  test("rounds to the spacing and clamps at the bounds", () => {
    expect(nearestUsableTick(0, 10)).toBe(0);
    expect(nearestUsableTick(14, 10)).toBe(10);
    expect(nearestUsableTick(15, 10)).toBe(20);
    expect(nearestUsableTick(-14, 10)).toBe(-10);
    expect(nearestUsableTick(-15, 10)).toBe(-10);
    expect(nearestUsableTick(MIN_TICK, 60)).toBe(-887220);
    expect(nearestUsableTick(MAX_TICK, 60)).toBe(887220);
    expect(nearestUsableTick(MIN_TICK, 1)).toBe(MIN_TICK);
  });
  test("rejects a bad spacing", () => {
    expect(() => nearestUsableTick(0, 0)).toThrow(/tickSpacing/);
  });
});

// encodePriceSqrt(reserve1, reserve0) = floor(sqrt(r1/r0) * 2^96), as in the
// Uniswap tests.
const P_1_1 = 79228162514264337593543950336n;
const P_100_110 = 75541088972021052632782079082n;
const P_110_100 = 83095197869223157896060286990n;

describe("liquidity for amounts", () => {
  test("inside the range: the smaller of the two single-sided figures", () => {
    expect(getLiquidityForAmounts(P_1_1, P_100_110, P_110_100, 100n, 200n)).toBe(2148n);
  });
  test("below the range: only token0 counts", () => {
    expect(getLiquidityForAmounts(P_100_110 - 1n, P_100_110, P_110_100, 100n, 200n)).toBe(1048n);
    expect(getLiquidityForAmount0(P_100_110, P_110_100, 100n)).toBe(1048n);
  });
  test("above the range: only token1 counts", () => {
    expect(getLiquidityForAmounts(P_110_100, P_100_110, P_110_100, 100n, 200n)).toBe(2097n);
    expect(getLiquidityForAmount1(P_100_110, P_110_100, 200n)).toBe(2097n);
  });
  test("price order does not matter", () => {
    expect(getLiquidityForAmount0(P_110_100, P_100_110, 100n)).toBe(1048n);
  });
});

describe("amounts for liquidity", () => {
  test("inside, below and above the range", () => {
    expect(getAmountsForLiquidity(P_1_1, P_100_110, P_110_100, 2148n)).toEqual({ amount0: 99n, amount1: 99n });
    expect(getAmountsForLiquidity(P_100_110 - 1n, P_100_110, P_110_100, 2148n)).toEqual({ amount0: 204n, amount1: 0n });
    expect(getAmountsForLiquidity(P_110_100, P_100_110, P_110_100, 2148n)).toEqual({ amount0: 0n, amount1: 204n });
    expect(getAmount0ForLiquidity(P_100_110, P_110_100, 2148n)).toBe(204n);
    expect(getAmount1ForLiquidity(P_100_110, P_110_100, 2148n)).toBe(204n);
  });

  test("round-trips a realistic single-sided BNB position", () => {
    // 0.5 BNB entirely above the current price in a tickSpacing-10 pool.
    const lower = getSqrtPriceAtTick(-60000);
    const upper = getSqrtPriceAtTick(-59000);
    const current = getSqrtPriceAtTick(-61000);
    const liquidity = getLiquidityForAmounts(current, lower, upper, 5n * 10n ** 17n, 0n);
    const { amount0, amount1 } = getAmountsForLiquidity(current, lower, upper, liquidity);
    expect(amount1).toBe(0n);
    expect(amount0 <= 5n * 10n ** 17n).toBe(true);
    expect(amount0 > 5n * 10n ** 17n - 10n ** 12n).toBe(true);
  });
});
