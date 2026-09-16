import type { NetworkConfig } from "./config.js";
import { buildRelayClient } from "./internal/relay.js";
import {
  fetchFeeCurrencies,
  type FeeCurrenciesResult,
  type FeeCurrency,
} from "./internal/feeCurrencies.js";

export type FeeCurrenciesOptions = {
  /** Which chain to ask about. Resolved by the client from a chainId. */
  network: NetworkConfig;
};

/**
 * The tokens the relay accepts as payment for its fee on a chain, with the
 * rate it prices each at right now. Read live from the relay on every call:
 * the list and the rates are the relay's, not the SDK's.
 *
 * The native token comes first. When a call names no `feeToken`, the relay
 * charges whichever of these the wallet holds (the most valuable one when it
 * holds several), so a wallet funded with any listed token can transact.
 */
export async function feeCurrencies(opts: FeeCurrenciesOptions): Promise<FeeCurrenciesResult> {
  return fetchFeeCurrencies(buildRelayClient(opts.network), opts.network);
}

export { formatFeeAmount } from "./internal/feeCurrencies.js";
export type { FeeCurrenciesResult, FeeCurrency };
