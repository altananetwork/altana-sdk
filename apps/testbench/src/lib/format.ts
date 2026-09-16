import { formatUnits, parseUnits, type Address } from "viem";

/** Parses a human amount ("1.5") into base units; throws a readable error. */
export function parseAmount(text: string, decimals: number): bigint {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Amount "${text}" is not a number`);
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) throw new Error(`Amount "${text}" has more than ${decimals} decimals`);
  return parseUnits(t, decimals);
}

/** Formats base units with at most `maxFraction` fractional digits, trailing zeros trimmed. */
export function formatAmount(raw: bigint, decimals: number, maxFraction = 6): string {
  const s = formatUnits(raw, decimals);
  const [whole, frac = ""] = s.split(".");
  const cut = frac.slice(0, maxFraction).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : (whole ?? "0");
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * The relay's nativeRate is native wei per one whole token.
 * Returns both readings of that rate.
 */
export function rateStrings(
  nativeRate: bigint,
  tokenSymbol: string,
  nativeSym: string,
): { tokenInNative: string; nativeInToken: string } {
  if (nativeRate === 0n) return { tokenInNative: "no rate", nativeInToken: "no rate" };
  const tokenInNative = `1 ${tokenSymbol} = ${formatAmount(nativeRate, 18)} ${nativeSym}`;
  // tokens per one native, kept at 6 decimals: 1e18 * 1e6 / nativeRate
  const perNative = (10n ** 24n) / nativeRate;
  const nativeInToken = `1 ${nativeSym} = ${formatAmount(perNative, 6)} ${tokenSymbol}`;
  return { tokenInNative, nativeInToken };
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function secondsFromNow(days: number): number {
  return Math.floor(Date.now() / 1000) + Math.round(days * 86400);
}
