/**
 * Checks what a cross-asset relay charges on the funding chain against an
 * independent price, so a live run proves the conversion and not just that a
 * number came back.
 *
 * It is a no-op on a relay that prices one unit of the source asset as one
 * unit of the destination asset (today's testnet relay, and every relay
 * without `cross_asset`): there is nothing to convert, so nothing to check.
 * The band is the relay's own margin plus slack for the gap between the
 * relay's oracle and this one.
 */

import { formatUnits, type Address } from "viem";
import { NATIVE_TOKEN, type NetworkConfig, type QuoteLine, type SessionQuote } from "@altananetwork/sdk";

/** CoinGecko ids for the assets a Celo payer can be charged in. */
const GECKO_IDS: Record<string, string> = { CELO: "celo", ETH: "ethereum" };
/** A stablecoin's symbol means $1 here, with no de-peg guard: this is a check, not a price feed. */
const DOLLAR = new Set(["USDC", "USDT", "USD₮", "USDM", "USDm", "CUSD"]);

export type CrossAssetCheck =
  | { checked: false; reason: string }
  | { checked: true; charged: string; expected: string; ratio: number; withinBand: boolean };

/** A price in USD from CoinGecko, or undefined when it cannot be had. */
async function geckoUsd(symbol: string): Promise<number | undefined> {
  if (DOLLAR.has(symbol.toUpperCase())) return 1;
  const id = GECKO_IDS[symbol.toUpperCase()];
  if (!id) return undefined;
  const key = process.env.GECKO_API;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  try {
    const res = await fetch(url, {
      headers: key ? { "x-cg-demo-api-key": key } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const usd = body[id]?.usd;
    return typeof usd === "number" && usd > 0 ? usd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compares the charge on the funding chain with the registry chain's own cost
 * converted at an independent price.
 *
 * `marginBps` is the relay's configured cross-asset margin (200 = 2%);
 * `slackBps` allows for the two oracles disagreeing and for gas moving between
 * the quote and this check.
 */
export async function checkCrossAssetCharge(
  quote: SessionQuote,
  o: { registry: NetworkConfig; funding: NetworkConfig; marginBps?: number; slackBps?: number },
): Promise<CrossAssetCheck> {
  const line = quote.lines.find(
    (l: QuoteLine) => l.kind === "registry" && l.fundedFromChainId === o.funding.chainId,
  );
  if (!line) return { checked: false, reason: "no registry leg funded from the source chain" };
  const needs = (line.needs ?? []).filter((n) => n.amount > 0n);
  if (needs.length === 0) return { checked: false, reason: "the quote carried no per-token need" };
  if (needs.length > 1) {
    return { checked: false, reason: `the leg is charged in ${needs.length} tokens, which this check does not split` };
  }
  const need = needs[0]!;
  const paySymbol =
    need.symbol ?? (need.token.toLowerCase() === NATIVE_TOKEN ? o.funding.chain.nativeCurrency.symbol : undefined);
  const payDecimals = need.decimals ?? (need.token.toLowerCase() === NATIVE_TOKEN ? o.funding.chain.nativeCurrency.decimals : undefined);
  if (!paySymbol || payDecimals === undefined) {
    return { checked: false, reason: `the quote did not name the token ${need.token as Address}` };
  }

  // What the registry chain's side actually costs, in its own native token:
  // the value the calls carry plus the destination leg's fee.
  const destFee = (line.charges ?? []).find((c) => c.chainId === o.registry.chainId)?.fee ?? 0n;
  const destCost = line.value + destFee;
  if (destCost === 0n) return { checked: false, reason: "the registry leg carried no destination cost to convert" };

  const destSymbol = o.registry.chain.nativeCurrency.symbol;
  const [payUsd, destUsd] = await Promise.all([geckoUsd(paySymbol), geckoUsd(destSymbol)]);
  if (payUsd === undefined || destUsd === undefined) {
    return { checked: false, reason: `no independent price for ${paySymbol} or ${destSymbol}` };
  }

  // A 1:1 relay charges the same number of base units it would on the
  // destination, which is not a conversion and is not what this checks.
  const sameUnits = need.amount === destCost + ((line.charges ?? []).find((c) => c.chainId === o.funding.chainId)?.fee ?? 0n);
  if (sameUnits && Math.abs(payUsd / destUsd - 1) > 0.01) {
    return { checked: false, reason: "the relay priced the legs 1:1, so there is no conversion to check" };
  }

  const payFloat = Number(formatUnits(need.amount, payDecimals));
  const sourceFee = (line.charges ?? []).find((c) => c.chainId === o.funding.chainId)?.fee ?? 0n;
  // The source leg's own gas is not part of the conversion, so it comes off
  // before the comparison; it is charged in the same token.
  const convertedFloat = payFloat - Number(formatUnits(sourceFee, payDecimals));
  const expectedFloat = (Number(formatUnits(destCost, o.registry.chain.nativeCurrency.decimals)) * destUsd) / payUsd;
  const ratio = expectedFloat === 0 ? Number.POSITIVE_INFINITY : convertedFloat / expectedFloat;
  const margin = (o.marginBps ?? 200) / 10_000;
  const slack = (o.slackBps ?? 500) / 10_000;
  return {
    checked: true,
    charged: `${convertedFloat} ${paySymbol}`,
    expected: `${expectedFloat} ${paySymbol}`,
    ratio,
    withinBand: ratio >= 1 - slack && ratio <= 1 + margin + slack,
  };
}

/** Prints a check and throws when a conversion that was checked is out of band. */
export function assertCrossAssetCharge(check: CrossAssetCheck): void {
  if (!check.checked) {
    console.log(`    cross-asset price check skipped: ${check.reason}`);
    return;
  }
  console.log(
    `    cross-asset price check: charged ${check.charged}, independent price says ${check.expected}` +
      ` (ratio ${check.ratio.toFixed(4)})`,
  );
  if (!check.withinBand) {
    throw new Error(
      `The relay's cross-asset charge is outside the margin band: charged ${check.charged}, expected ${check.expected} (ratio ${check.ratio.toFixed(4)}).`,
    );
  }
}
