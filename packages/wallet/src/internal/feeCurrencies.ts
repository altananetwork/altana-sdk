/**
 * The relay's accepted fee tokens, read live from `wallet_getCapabilities`.
 *
 * Shared by the public `feeCurrencies()` and by the relay error hint, so the
 * list a caller sees and the list an error names are the same list.
 */
import { formatUnits, getAddress, numberToHex, type Address, type Client } from "viem";
import type { NetworkConfig } from "../config.js";

/** One token the relay accepts as payment for its fee on a chain. */
export type FeeCurrency = {
  /** The relay's asset id (for example `usdc`, `celo`). */
  uid: string;
  /** Token contract; the zero address for the native token. */
  address: Address;
  /** Display symbol; the chain's native currency symbol for the native token. */
  symbol: string;
  decimals: number;
  /**
   * Native wei per one whole unit of the token, as the relay prices it right
   * now. `10n ** 18n` for the native token itself.
   */
  nativeRate: bigint;
  isNative: boolean;
};

/** The relay's fee tokens for one chain. */
export type FeeCurrenciesResult = {
  chainId: number;
  /** Native first, then by symbol. */
  currencies: FeeCurrency[];
  /** Seconds a relay price stays valid before the token stops being quoted. */
  rateTtl: number;
};

/** One `fees.tokens` entry as the relay serializes it. */
type WireFeeToken = {
  uid?: unknown;
  address?: unknown;
  decimals?: unknown;
  feeToken?: unknown;
  symbol?: unknown;
  nativeRate?: unknown;
};

type WireChainCapabilities = {
  fees?: { tokens?: unknown; quoteConfig?: { rateTtl?: unknown } };
};

/** Fetches and parses the relay's fee tokens for `network`. */
export async function fetchFeeCurrencies(
  relay: Client,
  network: NetworkConfig,
): Promise<FeeCurrenciesResult> {
  const chainHex = numberToHex(network.chainId);
  const response = (await relay.request({
    method: "wallet_getCapabilities" as never,
    params: [[chainHex]] as never,
  })) as Record<string, WireChainCapabilities> | null;
  const chain = findChain(response, network.chainId);
  if (!chain) {
    throw new Error(
      `The Altana relay${network.relayUrl ? ` at ${network.relayUrl}` : ""} does not serve ` +
        `chain ${network.chainId} (its wallet_getCapabilities has no entry for it).`,
    );
  }
  return parseFeeCurrencies(chain, network);
}

/** `wallet_getCapabilities` keys chains by hex id; accept decimal too. */
function findChain(
  response: Record<string, WireChainCapabilities> | null,
  chainId: number,
): WireChainCapabilities | undefined {
  if (!response || typeof response !== "object") return undefined;
  for (const [key, value] of Object.entries(response)) {
    const id = key.startsWith("0x") ? parseInt(key, 16) : Number(key);
    if (id === chainId) return value;
  }
  return undefined;
}

/**
 * Maps one chain's capabilities to `FeeCurrenciesResult`. Only entries the
 * relay marks `feeToken` with a live `nativeRate` are accepted fee tokens:
 * a token the relay lists but cannot price is not quotable and is left out.
 */
export function parseFeeCurrencies(
  chain: WireChainCapabilities,
  network: NetworkConfig,
): FeeCurrenciesResult {
  const tokens = Array.isArray(chain.fees?.tokens) ? (chain.fees.tokens as WireFeeToken[]) : [];
  const currencies: FeeCurrency[] = [];
  for (const token of tokens) {
    if (token.feeToken !== true) continue;
    if (typeof token.address !== "string" || typeof token.nativeRate !== "string") continue;
    const address = getAddress(token.address);
    const isNative = /^0x0{40}$/i.test(address);
    const uid = typeof token.uid === "string" ? token.uid : address;
    currencies.push({
      uid,
      address,
      // The relay labels the native entry from whatever its asset lookup
      // returned; the chain config is the authority on the native symbol.
      symbol: isNative
        ? network.chain.nativeCurrency.symbol
        : typeof token.symbol === "string" && token.symbol
          ? token.symbol
          : uid,
      decimals: typeof token.decimals === "number" ? token.decimals : 18,
      nativeRate: BigInt(token.nativeRate),
      isNative,
    });
  }
  // Native first, then by symbol code units (locale independent).
  currencies.sort((a, b) => {
    if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
  const rateTtl = chain.fees?.quoteConfig?.rateTtl;
  return {
    chainId: network.chainId,
    currencies,
    rateTtl: typeof rateTtl === "number" ? rateTtl : 300,
  };
}

/** `0.12 USDC`: an amount in the token's smallest unit, in whole tokens with its symbol. */
export function formatFeeAmount(
  amount: bigint,
  currency: { symbol: string; decimals: number },
): string {
  return `${formatUnits(amount, currency.decimals)} ${currency.symbol}`;
}

/**
 * The hint appended to a "fee token" relay rejection: which tokens the relay
 * accepts on this chain, read live. Falls back to a generic sentence when
 * the relay cannot be asked.
 */
export async function feeTokenHint(relay: Client, network: NetworkConfig): Promise<string> {
  try {
    const { currencies } = await fetchFeeCurrencies(relay, network);
    if (currencies.length > 0) {
      const symbols = currencies.map((c) => c.symbol).join(", ");
      return (
        ` (fee tokens the relay accepts on ${network.chain.name}: ${symbols}. Omit \`feeToken\` ` +
        `and the relay charges whichever of these the wallet holds, or set one of them; ` +
        `$U is for job escrow and x402, not relay fees)`
      );
    }
  } catch {
    // The rejection is the message; the hint is best effort.
  }
  return (
    " (omit `feeToken` and the relay charges an accepted token the wallet holds, or set one " +
    "the relay lists in feeCurrencies(); $U is for job escrow and x402, not relay fees)"
  );
}
