/**
 * JSON shaping for wallet_balance. Tool results are text, so every bigint the
 * SDK returns becomes a decimal string here; the structure otherwise mirrors
 * the SDK's TokenBalance so a host can read either interchangeably.
 */
import { formatEther, type Address } from "viem";
import type { TokenBalance } from "@altananetwork/sdk";

export type TokenBalanceJson =
  | {
      address: Address;
      symbol: string;
      decimals: number;
      raw: string;
      display: string;
      scaled?: {
        uiMultiplier: string;
        scaledRaw: string;
        pending?: { newUIMultiplier: string; effectiveAt: string };
      };
    }
  | { address: Address; error: string };

export type BalanceJson = {
  name: string;
  address: Address;
  balanceWei: string;
  balanceEth: string;
  tokens?: TokenBalanceJson[];
  /** Present (true) when `tokens` came from relay discovery rather than an explicit list. */
  discovered?: true;
};

/** One TokenBalance → its JSON-safe twin (bigints as decimal strings). */
export function formatTokenBalance(t: TokenBalance): TokenBalanceJson {
  if (!t.ok) return { address: t.address, error: t.error };
  return {
    address: t.address,
    symbol: t.symbol,
    decimals: t.decimals,
    raw: t.raw.toString(),
    display: t.display,
    ...(t.scaled
      ? {
          scaled: {
            uiMultiplier: t.scaled.uiMultiplier.toString(),
            scaledRaw: t.scaled.scaledRaw.toString(),
            ...(t.scaled.pending
              ? {
                  pending: {
                    newUIMultiplier: t.scaled.pending.newUIMultiplier.toString(),
                    effectiveAt: t.scaled.pending.effectiveAt.toString(),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The full wallet_balance payload. `tokens` is omitted when the SDK returned
 * none (native-only call); `discovered: true` marks a relay-discovered list.
 */
export function formatBalance(o: {
  name: string;
  address: Address;
  native: bigint;
  tokens?: TokenBalance[];
  discovered?: boolean;
}): BalanceJson {
  return {
    name: o.name,
    address: o.address,
    balanceWei: o.native.toString(),
    balanceEth: formatEther(o.native),
    ...(o.tokens !== undefined ? { tokens: o.tokens.map(formatTokenBalance) } : {}),
    ...(o.discovered ? { discovered: true as const } : {}),
  };
}
