import type { FeeCurrency, SessionPermissions, SpendPermission } from "@altananetwork/sdk";
import type { Address } from "viem";
import { STABLECOINS } from "./chains";
import { formatAmount, isAddress, parseAmount, sameAddress, secondsFromNow } from "./format";

export type CapInput = { amount: string; period: SpendPermission["period"]; token: Address | "native" };

export type SessionForm = {
  name: string;
  caps: CapInput[];
  scopeTo: string;
  days: string;
  chainIds: number[];
  feeTokens: Address[];
  /**
   * Write the key into the Ethereum Sepolia KeyStore as well as authorizing it
   * on the account (default true, the SDK's own default).
   *
   * Turning it off keeps the grant on Celo: the account still enforces the
   * scope, the caps and the expiry, so the session is a real boundary, but
   * there is no KeyStore entry and therefore nothing for the Celo mirror to
   * prove. It is also the only way to grant on a live relay today, because the
   * registry write is the step blocked by the relay's funder-signature bug.
   */
  register: boolean;
  /**
   * Tokens this session will pay x402 with. For each, the grant approves both
   * contracts that can verify the key's signature: Permit2 for the permit2
   * rails and the token itself for eip3009, in one intent.
   *
   * Without it a session is granted that cannot pay, and the failure arrives
   * later as `FiatTokenV2: invalid signature` or a silent Permit2 revert, with
   * nothing naming the missing approval
   * (evidence/2026-10-05-x402-session-approvals.md).
   */
  x402Tokens: Address[];
};

export const PERIODS: SpendPermission["period"][] = ["minute", "hour", "day", "week", "month", "year"];

export function defaultForm(chainId: number): SessionForm {
  return { name: "", caps: [{ amount: "0.05", period: "day", token: "native" }], scopeTo: "", days: "7", chainIds: [chainId], feeTokens: [], register: true, x402Tokens: [] };
}

/**
 * A token a spend cap can be set in, with the decimals the cap is scaled by.
 *
 * **Decimals are the reason this type exists.** A cap is stored as an integer
 * of the token's smallest unit, so resolving a 6-decimal token at 18 decimals
 * writes a cap 10^12 times larger than the one asked for. That is not a
 * mislabelled cap, it is the absence of one. A token whose decimals are not
 * known is therefore refused rather than defaulted.
 */
export type CapToken = { symbol: string; address: Address; decimals: number };

/**
 * Every token a spend cap can be set in on one chain.
 *
 * **Not the relay's fee currencies.** A cap bounds what the session *spends*;
 * the fee list is what the relay accepts for *gas*. On the live relay the two
 * barely overlap: it offers S-CELO, while the session pays x402 in USDC, so
 * sourcing cap tokens from the fee list leaves the cap unsettable in the one
 * token being spent (qa, 2026-10-05). The fee currencies are still included,
 * because they are real tokens on the chain and carry decimals read from the
 * relay rather than from this file.
 */
export function capTokenOptions(
  chainId: number,
  currencies: readonly FeeCurrency[],
  extra: readonly CapToken[] = [],
): readonly CapToken[] {
  const out: CapToken[] = [];
  const add = (t: CapToken) => {
    if (!out.some((x) => sameAddress(x.address, t.address))) out.push(t);
  };
  for (const c of currencies) if (!c.isNative) add({ symbol: c.symbol, address: c.address, decimals: c.decimals });
  for (const t of STABLECOINS[chainId] ?? []) add({ symbol: t.symbol, address: t.address, decimals: t.decimals });
  for (const t of extra) add(t);
  return out;
}

/**
 * Ticking a token to pay x402 with points the first spend cap at it, unless a
 * cap already names an ERC-20.
 *
 * The cap and the x402 token answer one question between them, namely what
 * this session may spend, so a grant that approves USDC for x402 and caps only the
 * native token is unbounded in the token it actually spends. Only a cap left
 * on the native token is retargeted: once a cap names an ERC-20, someone chose
 * it.
 */
export function withX402Cap(form: SessionForm, token: Address): SessionForm {
  if (form.caps.some((c) => c.token !== "native")) return form;
  if (form.caps.length === 0) return form;
  return { ...form, caps: form.caps.map((c, i) => (i === 0 ? { ...c, token } : c)) };
}

/** Builds the SDK permissions and expiry from the form; throws readable errors. */
export function buildGrant(form: SessionForm, capTokens: readonly CapToken[]): { permissions: SessionPermissions; expiry: number } {
  if (form.caps.length === 0) throw new Error("Add at least one spend cap.");
  const spend: SpendPermission[] = form.caps.map((c) => {
    if (c.token === "native") return { limit: parseAmount(c.amount, 18), period: c.period };
    const cur = capTokens.find((x) => sameAddress(x.address, c.token));
    if (!cur)
      throw new Error(
        `Unknown token ${c.token}: its decimals are not known here, and a cap scaled by the wrong decimals is not a cap. Pick a listed token.`,
      );
    return { limit: parseAmount(c.amount, cur.decimals), period: c.period, token: cur.address };
  });
  const days = Number(form.days);
  if (!Number.isFinite(days) || days <= 0) throw new Error("Lifetime must be a positive number of days.");
  const scope = form.scopeTo.trim();
  if (scope && !isAddress(scope)) throw new Error("Scope must be a contract address.");
  if (form.chainIds.length === 0) throw new Error("Pick at least one chain.");
  return {
    permissions: { ...(scope ? { calls: [{ to: scope as Address }] } : {}), spend },
    expiry: secondsFromNow(days),
  };
}

/**
 * Caps in words. Decimals come from the same token list the cap was built
 * from, so a cap set in USDC reads back in USDC rather than as an 18-decimal
 * fraction of itself.
 */
export function describeCaps(spend: readonly { limit: string | bigint; period: string; token?: Address }[], capTokens: readonly CapToken[], native: string): string {
  return spend
    .map((s) => {
      const cur = s.token ? capTokens.find((c) => sameAddress(c.address, s.token)) : undefined;
      const decimals = cur?.decimals ?? 18;
      const symbol = cur?.symbol ?? (s.token ? s.token : native);
      return `${formatAmount(BigInt(s.limit), decimals)} ${symbol} per ${s.period}`;
    })
    .join(", ");
}

/** A grant or revoke progress event in words, with why a step may take a while. */
export function describeStatus(status: string, chain: string | undefined, elapsedSec: number): string {
  const since = elapsedSec >= 60 ? ` (${Math.floor(elapsedSec / 60)} min ${elapsedSec % 60} s)` : elapsedSec > 0 ? ` (${elapsedSec} s)` : "";
  switch (status) {
    case "discovery":
      return `Reading the key's current state${since}`;
    case "registry-write":
      return `Writing the key to the Keystore on Sepolia${since}`;
    case "account-authorization":
      return `Authorizing the key on the account on ${chain ?? "the chain"}${since}`;
    case "account-revoke":
      return `Revoking the key on the account on ${chain ?? "the chain"}${since}`;
    case "cache-sync":
      return (
        `Proving the Keystore entry into the cache on ${chain ?? "the chain"}${since}. ` +
        `This waits for the chain's L1 anchor to pass the Sepolia block of the Keystore write; ` +
        `Celo Sepolia's anchor moves every 6 to 8 minutes and runs 15 to 20 minutes behind Sepolia.`
      );
    case "done":
      return "Done";
    default:
      return `${status}${since}`;
  }
}
