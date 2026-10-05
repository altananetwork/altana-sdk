import type { FeeCurrency, SessionPermissions, SpendPermission } from "@altananetwork/sdk";
import type { Address } from "viem";
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
};

export const PERIODS: SpendPermission["period"][] = ["minute", "hour", "day", "week", "month", "year"];

export function defaultForm(chainId: number): SessionForm {
  return { name: "", caps: [{ amount: "0.05", period: "day", token: "native" }], scopeTo: "", days: "7", chainIds: [chainId], feeTokens: [], register: true };
}

/** Builds the SDK permissions and expiry from the form; throws readable errors. */
export function buildGrant(form: SessionForm, currencies: readonly FeeCurrency[]): { permissions: SessionPermissions; expiry: number } {
  if (form.caps.length === 0) throw new Error("Add at least one spend cap.");
  const spend: SpendPermission[] = form.caps.map((c) => {
    if (c.token === "native") return { limit: parseAmount(c.amount, 18), period: c.period };
    const cur = currencies.find((x) => sameAddress(x.address, c.token));
    if (!cur) throw new Error(`Unknown token ${c.token}`);
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

export function describeCaps(spend: readonly { limit: string | bigint; period: string; token?: Address }[], currencies: readonly FeeCurrency[], native: string): string {
  return spend
    .map((s) => {
      const cur = s.token ? currencies.find((c) => sameAddress(c.address, s.token)) : undefined;
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
