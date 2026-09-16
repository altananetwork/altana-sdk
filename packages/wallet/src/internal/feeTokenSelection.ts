/**
 * Which token a call pays the relay fee in.
 *
 * The relay understands one named fee token or none. Left blank, the relay
 * picks the accepted token the wallet holds, which is right for a wallet
 * (admin) key. For a session key porto fills the blank itself with the first
 * token of the session's spend permission before the relay sees the request,
 * so the SDK decides for sessions. The rule, in order:
 *
 *   1. `feeToken` named: use it, any key.
 *   2. `feeTokens` named: the first of the list that the relay accepts on the
 *      chain and the wallet holds.
 *   3. Nothing named, wallet key: send none; the relay picks.
 *   4. Nothing named, session key: among the tokens of the session's spend
 *      permission (native included when the cap is native), those the relay
 *      accepts, the one the wallet holds the most of in the relay's own
 *      terms. Sent explicitly so porto cannot guess.
 *
 * A choice that finds nothing to pay with fails before anything reaches the
 * relay, naming the accepted tokens and what the wallet holds.
 */
import { createPublicClient, formatUnits, getAddress, http, type Address, type Client } from "viem";
import { NATIVE_TOKEN, type NetworkConfig } from "../config.js";
import { fetchFeeCurrencies, type FeeCurrency } from "./feeCurrencies.js";
import type { SessionPermissions, SpendPermission } from "./sessions.js";
import { readTokenBalances } from "./tokenBalances.js";

/** Where the candidate tokens came from; it shapes the error messages. */
export type FeeTokenSource = "feeTokens" | "session";

/** Raw balances keyed by lowercase address; `NATIVE_TOKEN` for the native token. */
export type HeldBalances = ReadonlyMap<string, bigint>;

export function isNativeAddress(address: Address): boolean {
  return address.toLowerCase() === NATIVE_TOKEN;
}

/** The part of a key's permissions the fee token rule reads. */
export type SpendCapTokens = { spend?: readonly { token?: Address }[] };

/** The fee token candidates of a session: the tokens its spend permission caps. */
export function feeTokenCandidatesOf(permissions: SpendCapTokens | undefined): Address[] {
  return (permissions?.spend ?? []).map((cap) => cap.token ?? NATIVE_TOKEN);
}

/** One candidate the relay accepts, with the wallet's balance valued in native wei. */
export type RankedFeeCandidate = {
  currency: FeeCurrency;
  raw: bigint;
  /** `raw` converted at the relay's rate: comparable across tokens. */
  value: bigint;
};

/**
 * Keeps, in caller order and without duplicates, the candidates the relay
 * accepts, valuing each by the wallet's balance at the relay's rate.
 */
export function rankFeeCandidates(
  candidates: readonly Address[],
  accepted: readonly FeeCurrency[],
  held: HeldBalances,
): RankedFeeCandidate[] {
  const seen = new Set<string>();
  const ranked: RankedFeeCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const currency = accepted.find((c) => c.address.toLowerCase() === key);
    if (!currency) continue;
    const raw = held.get(key) ?? 0n;
    const value = (raw * currency.nativeRate) / 10n ** BigInt(currency.decimals);
    ranked.push({ currency, raw, value });
  }
  return ranked;
}

/**
 * Picks the fee token, or throws with what would have worked. `feeTokens`
 * takes the first held candidate in caller order; `session` the one with the
 * largest balance in relay terms.
 */
export function chooseFeeToken(args: {
  candidates: readonly Address[];
  accepted: readonly FeeCurrency[];
  held: HeldBalances;
  source: FeeTokenSource;
  network: NetworkConfig;
  walletAddress: Address;
}): Address {
  const { network, walletAddress, source } = args;
  const acceptedList = args.accepted.map((c) => c.symbol).join(", ");
  const origin =
    source === "feeTokens" ? "named in `feeTokens`" : "in the session's spend permission";
  const ranked = rankFeeCandidates(args.candidates, args.accepted, args.held);
  if (ranked.length === 0) {
    throw new Error(
      `None of the tokens ${origin} (${args.candidates.join(", ")}) is a fee token the relay ` +
        `accepts on ${network.chain.name} (chainId ${network.chainId}). It accepts: ${acceptedList}. ` +
        (source === "feeTokens"
          ? "Pass one of those in `feeTokens`, or pass `feeToken` to force one."
          : "Grant the session a spend cap on one of those (grantSession's `feeToken` / " +
            "`feeTokens` adds it), or pass `feeToken` to force one."),
    );
  }
  const heldOnes = ranked.filter((r) => r.raw > 0n);
  if (heldOnes.length === 0) {
    const could = ranked.map((r) => r.currency.symbol).join(", ");
    throw new Error(
      `The wallet ${walletAddress} holds none of the tokens it could pay the relay fee with on ` +
        `${network.chain.name} (chainId ${network.chainId}): ${could}. Fund it with one of them; ` +
        `the relay accepts ${acceptedList}.`,
    );
  }
  if (source === "feeTokens") return heldOnes[0]!.currency.address;
  let best = heldOnes[0]!;
  for (const r of heldOnes) if (r.value > best.value) best = r;
  return best.currency.address;
}

/** Reads the wallet's balance of each token on the chain's public RPC. */
export async function readHeldBalances(
  network: NetworkConfig,
  walletAddress: Address,
  tokens: readonly Address[],
): Promise<HeldBalances> {
  const publicClient = createPublicClient({
    chain: network.chain,
    transport: http(network.publicRpcUrl),
  });
  const erc20s = tokens.filter((t) => !isNativeAddress(t));
  const wantsNative = tokens.some(isNativeAddress);
  const [native, balances] = await Promise.all([
    wantsNative ? publicClient.getBalance({ address: walletAddress }) : Promise.resolve(0n),
    readTokenBalances(publicClient, walletAddress, erc20s),
  ]);
  const held = new Map<string, bigint>();
  if (wantsNative) held.set(NATIVE_TOKEN, native);
  for (const b of balances) held.set(b.address.toLowerCase(), b.ok ? b.raw : 0n);
  return held;
}

/**
 * Applies the rule above for one submission. Returns the token to name in
 * the request, or undefined to let the relay pick.
 */
export async function resolveFeeToken(args: {
  relay: Client;
  network: NetworkConfig;
  walletAddress: Address;
  feeToken?: Address;
  feeTokens?: readonly Address[];
  submittingKey: { role: "admin" | "session"; permissions?: SpendCapTokens };
}): Promise<Address | undefined> {
  if (args.feeToken) return args.feeToken;
  let candidates: readonly Address[];
  let source: FeeTokenSource;
  if (args.feeTokens) {
    candidates = args.feeTokens.map((t) => getAddress(t));
    source = "feeTokens";
  } else if (args.submittingKey.role === "session") {
    candidates = feeTokenCandidatesOf(args.submittingKey.permissions);
    source = "session";
    // A session with no spend cap has nothing porto could guess from; the
    // relay picks, as for a wallet key.
    if (candidates.length === 0) return undefined;
  } else {
    return undefined;
  }
  const { currencies: accepted } = await fetchFeeCurrencies(args.relay, args.network);
  const eligible = rankFeeCandidates(candidates, accepted, new Map()).map((r) => r.currency.address);
  const held =
    eligible.length > 0 ? await readHeldBalances(args.network, args.walletAddress, eligible) : new Map();
  return chooseFeeToken({
    candidates,
    accepted,
    held,
    source,
    network: args.network,
    walletAddress: args.walletAddress,
  });
}

/**
 * The session permissions with a daily spend cap on each fee token that has
 * none yet, so the session can pay the relay fee in it. Every token must be
 * one the relay accepts on the chain. `limit` is in the token's smallest
 * unit and applies to each added cap; the default is one whole token.
 */
export function addFeeSpendCaps(
  permissions: SessionPermissions,
  feeTokens: readonly Address[],
  accepted: readonly FeeCurrency[],
  network: NetworkConfig,
  limit?: bigint,
): SessionPermissions {
  const spend: SpendPermission[] = [...(permissions.spend ?? [])];
  for (const token of feeTokens) {
    const currency = accepted.find((c) => c.address.toLowerCase() === token.toLowerCase());
    if (!currency) {
      throw new Error(
        `${token} is not a fee token the relay accepts on ${network.chain.name} (chainId ` +
          `${network.chainId}); a session cannot pay fees in it. It accepts: ` +
          `${accepted.map((c) => c.symbol).join(", ")}.`,
      );
    }
    const already = spend.some((cap) => (cap.token ?? NATIVE_TOKEN).toLowerCase() === token.toLowerCase());
    if (already) continue;
    spend.push({
      limit: limit ?? 10n ** BigInt(currency.decimals),
      period: "day",
      ...(currency.isNative ? {} : { token: currency.address }),
    });
  }
  return { ...permissions, spend };
}

/** `addFeeSpendCaps` with the relay's accepted list read live. */
export async function withFeeSpendCaps(
  relay: Client,
  network: NetworkConfig,
  permissions: SessionPermissions,
  feeTokens: readonly Address[],
  limit?: bigint,
): Promise<SessionPermissions> {
  if (feeTokens.length === 0) return permissions;
  const { currencies } = await fetchFeeCurrencies(relay, network);
  return addFeeSpendCaps(permissions, feeTokens, currencies, network, limit);
}

/** `1.5 USDC`-style rendering of a ranked candidate, for logs and errors. */
export function describeHeld(candidate: RankedFeeCandidate): string {
  return `${formatUnits(candidate.raw, candidate.currency.decimals)} ${candidate.currency.symbol}`;
}
