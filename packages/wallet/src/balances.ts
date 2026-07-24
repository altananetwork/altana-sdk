import { type NetworkConfig } from "./config.js";
import { buildPublicClient } from "./internal/relay.js";
import { readTokenBalances } from "./internal/tokenBalances.js";
import type { Address } from "viem";
import type { Wallet } from "./internal/types.js";

/** One entry per requested token, same order as the input `tokens` array. */
export type TokenBalance =
  | {
      address: Address;
      ok: true;
      /** Raw on-chain balanceOf — the value transfers and allowances use. */
      raw: bigint;
      decimals: number;
      /** "" if symbol() is missing/undecodable (after the bytes32 fallback). */
      symbol: string;
      /**
       * Human display string. For BEP-677 tokens this is
       * formatUnits(raw * uiMultiplier / 1e18, decimals) with integer
       * truncation per the spec; otherwise formatUnits(raw, decimals).
       */
      display: string;
      /** Present iff the token implements IScaledUIAmount (ERC-165 0xa60bf13d). */
      scaled?: {
        /** Active multiplier, 1e18 fixed-point (1e18 = 1.0x). */
        uiMultiplier: bigint;
        /** raw * uiMultiplier / 1e18, truncated — the bigint behind `display`. */
        scaledRaw: bigint;
        /** Present iff a scheduled multiplier change has not yet taken effect. */
        pending?: { newUIMultiplier: bigint; effectiveAt: bigint };
      };
    }
  | {
      address: Address;
      ok: false;
      /** Why the token could not be read (balanceOf or decimals reverted). */
      error: string;
    };

export type BalancesResult = {
  /** Native token balance in wei. */
  native: bigint;
  /** Present iff `tokens` was passed (empty input array → empty output array). */
  tokens?: TokenBalance[];
};

/**
 * Reads on-chain balances for a wallet.
 *
 * Pass `tokens` to also read ERC-20 balances. Tokens implementing BEP-677
 * (scaled UI amount, detected via ERC-165) get their display value scaled by
 * uiMultiplier automatically; raw amounts are always returned unscaled.
 */
export async function balances(
  walletOrAddress: Wallet | Address,
  opts: { network: NetworkConfig; tokens?: readonly Address[] },
): Promise<BalancesResult> {
  const network = opts.network;
  const address = typeof walletOrAddress === "string"
    ? walletOrAddress
    : walletOrAddress.address;

  const publicClient = buildPublicClient(network);
  const [native, tokens] = await Promise.all([
    publicClient.getBalance({ address }),
    opts.tokens !== undefined
      ? readTokenBalances(publicClient, address, opts.tokens)
      : Promise.resolve(undefined),
  ]);

  return { native, ...(tokens !== undefined ? { tokens } : {}) };
}
