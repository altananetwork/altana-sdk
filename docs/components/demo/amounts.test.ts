import { describe, expect, test } from 'bun:test'
import { formatAmount } from './amounts'

/** The balance line in the live demos. */
describe('a token amount in the live demos', () => {
  test('whole amounts have no decimals', () => {
    expect(formatAmount(18_000000000000000000n)).toBe('18')
    expect(formatAmount(0n)).toBe('0')
  })

  test('at most four decimals, with trailing zeros dropped', () => {
    expect(formatAmount(9_427016746949030517n)).toBe('9.427')
    expect(formatAmount(9_430000000000000000n)).toBe('9.43')
    expect(formatAmount(933000000000000n)).toBe('0.0009')
  })

  test('is cut, never rounded up, so a balance does not read higher than it is', () => {
    expect(formatAmount(1_999999999999999999n)).toBe('1.9999')
    expect(formatAmount(999999999999999999n)).toBe('0.9999')
  })

  test('an amount too small to show is not written as zero', () => {
    expect(formatAmount(1n)).toBe('<0.0001')
    expect(formatAmount(99999999999999n)).toBe('<0.0001')
  })

  test('other decimals: a 6 decimal stablecoin', () => {
    expect(formatAmount(1_500000n, 6)).toBe('1.5')
    expect(formatAmount(1_234567n, 6, 2)).toBe('1.23')
  })

  test('a negative amount reads as zero', () => {
    expect(formatAmount(-5n)).toBe('0')
  })
})
