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
};

export const PERIODS: SpendPermission["period"][] = ["minute", "hour", "day", "week", "month", "year"];

export function defaultForm(chainId: number): SessionForm {
  return { name: "", caps: [{ amount: "0.05", period: "day", token: "native" }], scopeTo: "", days: "7", chainIds: [chainId], feeTokens: [] };
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
