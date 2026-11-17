/**
 * How the live demos write a token amount: "9.43", "0.0009", "18".
 *
 * No React here, so it is unit tested on its own (amounts.test.ts).
 */

/**
 * A base-unit amount as a short decimal: at most `maxFractionDigits` after the
 * point, cut and never rounded up (a balance must not read higher than it is),
 * with trailing zeros dropped. An amount too small to show reads "<0.0001".
 */
export function formatAmount(amount: bigint, decimals = 18, maxFractionDigits = 4): string {
  if (amount <= 0n) return '0'
  const unit = 10n ** BigInt(decimals)
  const whole = amount / unit
  const fraction = (amount % unit).toString().padStart(decimals, '0').slice(0, maxFractionDigits)
  const trimmed = fraction.replace(/0+$/, '')
  if (whole === 0n && trimmed === '') return `<0.${'0'.repeat(maxFractionDigits - 1)}1`
  return trimmed ? `${whole}.${trimmed}` : whole.toString()
}
