/**
 * The `x402Tokens` input of `grant_session`: the tokens a session is set up to
 * pay x402 requests in.
 *
 * No I/O, so it is unit tested on its own (x402Tokens.test.ts).
 */
import type { Address } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * One address or a list, as a checked list with duplicates removed.
 * `undefined` and an empty list both mean the session is not set up for x402.
 * The native coin is refused: an x402 payment moves a token.
 */
export function x402TokensFrom(value: string | readonly string[] | undefined): Address[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? [value] : [...value];
  if (list.length === 0) return undefined;
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const token of list) {
    if (!ADDRESS.test(token)) throw new Error(`Not a valid 0x-prefixed 20-byte address: ${token}`);
    if (token.toLowerCase() === NATIVE) {
      throw new Error("x402Tokens takes token contract addresses: an x402 payment is made in a token, not in the chain's native coin.");
    }
    if (seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    out.push(token as Address);
  }
  return out;
}

/**
 * The `x402SpendLimit` input of `grant_session`: one daily spend cap per x402
 * token, in the token's smallest unit.
 *
 * The cap is what `x402_request` measures a payment against before signing it.
 * Left out, the session has no cap on these tokens and pays whatever a seller
 * asks, which is what an x402 session did before the input existed.
 */
export function x402SpendCapsFrom(
  tokens: readonly Address[] | undefined,
  limit: string | undefined,
): { token: Address; limit: bigint; period: "day" }[] {
  if (limit === undefined) return [];
  if (!/^\d+$/.test(limit) || BigInt(limit) === 0n) {
    throw new Error(`x402SpendLimit is a whole number above zero in the token's smallest unit (for example 5000000 for 5 USDC), got: ${limit}`);
  }
  if (!tokens || tokens.length === 0) {
    throw new Error("x402SpendLimit caps the tokens named in x402Tokens, so it needs x402Tokens too.");
  }
  return tokens.map((token) => ({ token, limit: BigInt(limit), period: "day" as const }));
}
