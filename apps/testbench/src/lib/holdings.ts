/**
 * Holdings the relay cannot enumerate, read from the chain and merged in.
 *
 * The relay answers ERC-7811 `wallet_getAssets` with the native balance alone
 * on Celo Sepolia: its token discovery runs on NodeReal, which is enabled for
 * chains 1 and 56 only. A wallet holding 0.09 USDC was reported as holding no
 * tokens, "Move everything" stranded them, and recovering them took a plain
 * transfer through `execute` (qa, 2026-10-05). So this is not the G1 oracle gap
 * and will not lift with it.
 *
 * **The relay's answer is kept, not replaced.** Anything it lists is used as
 * given, the chain fills only what it did not mention, and every entry records
 * which of the two it came from. A silent substitution would hide the relay gap
 * from whoever next wonders why the bench and the relay disagree.
 */

import { erc20Abi, type Address, type PublicClient } from "viem";
import type { HoldingsResult, TokenBalance } from "@altananetwork/sdk";
import { relayReason } from "./errors";
import { formatAmount, sameAddress } from "./format";
import { capTokenOptions } from "./sessions";
import type { FeeCurrency } from "@altananetwork/sdk";

/** A token worth asking about, from the chain's registry or the relay's lists. */
export type KnownToken = { address: Address; symbol: string; decimals: number };

/** Where a balance came from, so the relay's silence stays visible. */
export type BalanceSource = "relay" | "chain";

export type MergedHoldings = {
  native: bigint;
  tokens: readonly (TokenBalance & { via: BalanceSource })[];
};

/**
 * Reads `balanceOf` for each token the relay did not list.
 *
 * Failures are kept as `ok: false` rather than dropped: a token whose read
 * failed is not a token known to be absent, and the sweep must not treat the
 * two alike.
 */
export async function readOnChainBalances(
  client: Pick<PublicClient, "readContract">,
  owner: Address,
  tokens: readonly KnownToken[],
): Promise<readonly TokenBalance[]> {
  const reads = tokens.map(async (t): Promise<TokenBalance> => {
    try {
      const raw = (await client.readContract({
        address: t.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;
      return { address: t.address, ok: true, raw, decimals: t.decimals, symbol: t.symbol, display: formatAmount(raw, t.decimals) };
    } catch (e) {
      // A balanceOf that reverts carries its reason the same way a relay
      // failure does, nested behind viem's wrapper, so it is decoded the same
      // way rather than shown as the outermost message.
      return { address: t.address, ok: false, error: relayReason(e) };
    }
  });
  return Promise.all(reads);
}

/**
 * The relay's holdings plus on-chain reads for everything it left out.
 *
 * Zero balances read from the chain are dropped, matching what the relay does
 * with its own, so the table does not fill with tokens nobody holds. A failed
 * read is kept.
 */
export function mergeHoldings(relay: HoldingsResult, onChain: readonly TokenBalance[]): MergedHoldings {
  const tokens: (TokenBalance & { via: BalanceSource })[] = relay.tokens.map((t) => ({ ...t, via: "relay" as const }));
  for (const t of onChain) {
    if (tokens.some((x) => sameAddress(x.address, t.address))) continue;
    if (t.ok && t.raw === 0n) continue;
    tokens.push({ ...t, via: "chain" });
  }
  return { native: relay.native, tokens };
}

/** Tokens the relay listed and tokens only the chain knows about, counted. */
export function describeSources(h: MergedHoldings): { relay: number; chain: number } {
  return {
    relay: h.tokens.filter((t) => t.via === "relay").length,
    chain: h.tokens.filter((t) => t.via === "chain").length,
  };
}

/**
 * Every token worth asking the chain about on one chain: the relay's fee
 * currencies and the bench's own registry, which is the same union a spend cap
 * may be set in. One list, so a token the bench can cap, pay x402 with or show
 * a balance for cannot be missing from one of the three.
 */
export function knownTokensFor(chainId: number, currencies: readonly FeeCurrency[]): readonly KnownToken[] {
  return capTokenOptions(chainId, currencies);
}

/**
 * The same list for the chain the app is currently on, from app state.
 *
 * The fee currencies are used only when they were loaded for this chain: a
 * list left over from the previous chain would ask for balances of tokens that
 * do not exist on this one.
 */
export function knownTokensOf(state: {
  chainId: number;
  feeCurrencies?: readonly FeeCurrency[];
  feeCurrenciesChainId?: number;
}): readonly KnownToken[] {
  const fresh = state.feeCurrenciesChainId === state.chainId ? state.feeCurrencies ?? [] : [];
  return knownTokensFor(state.chainId, fresh);
}
