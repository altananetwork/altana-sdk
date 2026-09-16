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
 * relay, naming the accepted tokens and what the wallet holds. Balances come
 * from the relay's own `wallet_getAssets`, never from a public RPC.
 */
import { getAddress, hexToBigInt, numberToHex, type Address, type Client, type Hex } from "viem";
import { NATIVE_TOKEN, type NetworkConfig } from "../config.js";
import { fetchFeeCurrencies, type FeeCurrency } from "./feeCurrencies.js";
import type { SessionPermissions, SpendPermission } from "./sessions.js";

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

/** One entry of the relay's ERC-7811 `wallet_getAssets` answer. */
type RelayAsset = { address?: unknown; balance?: unknown; type?: unknown };

/**
 * The wallet's balance of each token as the relay sees it: one
 * `wallet_getAssets` call (the same the relay uses to pick a fee token and
 * `holdings()` uses), filtered to `tokens`. No public RPC is involved, so a
 * session send depends on the relay alone. A token the relay does not list is
 * held at zero.
 */
export async function readHeldBalances(
  relay: Client,
  network: NetworkConfig,
  walletAddress: Address,
  tokens: readonly Address[],
): Promise<HeldBalances> {
  const chainIdHex = numberToHex(network.chainId);
  const response = (await relay.request({
    method: "wallet_getAssets" as never,
    params: [
      { account: walletAddress, assetTypeFilter: ["native", "erc20"], chainFilter: [chainIdHex] },
    ] as never,
  })) as Record<string, unknown> | null;

  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  const held = new Map<string, bigint>();
  for (const key of wanted) held.set(key, 0n);

  const assets = assetsForChain(response, network.chainId);
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null) {
      throw malformedAssets(walletAddress, network.chainId, "an entry is not an object");
    }
    const { address, balance, type } = asset as RelayAsset;
    if (typeof balance !== "string" || !/^0x[0-9a-fA-F]+$/.test(balance)) {
      throw malformedAssets(walletAddress, network.chainId, "a balance is not a hex quantity");
    }
    const isNative = type === "native" || address === "native";
    const key =
      isNative
        ? NATIVE_TOKEN
        : typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)
          ? address.toLowerCase()
          : undefined;
    if (!key) throw malformedAssets(walletAddress, network.chainId, "an address is not an address");
    // The relay may list the same token more than once; the first entry wins.
    if (wanted.has(key) && held.get(key) === 0n) held.set(key, hexToBigInt(balance as Hex));
  }
  return held;
}

/** The chain's list out of the ERC-7811 map (hex chain id keys; decimal tolerated). */
function assetsForChain(response: Record<string, unknown> | null, chainId: number): unknown[] {
  if (!response || typeof response !== "object") return [];
  for (const [key, value] of Object.entries(response)) {
    const id = key.startsWith("0x") ? parseInt(key, 16) : Number(key);
    if (id !== chainId) continue;
    if (!Array.isArray(value)) {
      throw new Error(
        `The relay returned a malformed wallet_getAssets response for chain ${chainId}: ` +
          `the chain's entry is not a list`,
      );
    }
    return value;
  }
  return [];
}

function malformedAssets(address: Address, chainId: number, what: string): Error {
  return new Error(
    `The relay returned a malformed wallet_getAssets response for ${address} on chain ${chainId}: ${what}`,
  );
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
  // An empty list names nothing: the key's own rule applies.
  if (args.feeTokens && args.feeTokens.length > 0) {
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
    eligible.length > 0
      ? await readHeldBalances(args.relay, args.network, args.walletAddress, eligible)
      : new Map();
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
