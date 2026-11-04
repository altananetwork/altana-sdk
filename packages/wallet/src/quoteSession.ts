/**
 * What a multi-chain grant or revoke would cost, before running it.
 *
 * The quote runs the same planning as grantSession and revokeSession (the
 * same discovery reads, the same legs, the same bundling), with every write
 * replaced by a quote: the relay's `prepareCalls` for relayed legs, a gas
 * estimate for direct registry transactions. Nothing is signed or sent.
 */

import { formatUnits, keccak256, type Address, type Hex } from "viem";
import { NATIVE_TOKEN, networkByChainId, type NetworkConfig } from "./config.js";
import { planRegistryFunding, planRegistryWrite, keyStoreCacheOf } from "./internal/cachedRegistry.js";
import { buildFirstActionPrepend, readActiveKeys, readPublicKey } from "./internal/keystore.js";
import { buildPublicClient, buildRelayClient, quoteCalls, type Call, type CallsQuote,
  type LegCharge, type QuoteLeg, type QuoteNeed,
} from "./internal/relay.js";
import { readTokenBalances } from "./internal/tokenBalances.js";
import { errorMessage, realSessionLegDeps, type SessionLegDeps } from "./internal/sessionLegs.js";
import type { GrantSessionOptions, Session, SessionLeg } from "./internal/sessions.js";
import type { Signer } from "./internal/signer.js";
import type { Wallet } from "./internal/types.js";
import { runGrantSession, type GrantSessionConfig } from "./grantSession.js";
import { runRevokeSession, type RevokeSessionOptions } from "./revokeSession.js";
import { buildPopulateKeyCall, readL1Anchor } from "./syncKeyToL2.js";

/** The cost of one leg. */
export type QuoteLine = {
  chainId: number;
  kind: SessionLeg["kind"];
  via?: SessionLeg["via"];
  /** Who pays: the wallet on relayed legs, the admin key on direct registry transactions. */
  payer: Address;
  /** Fee in `feeToken` base units (native wei when `feeToken` is the zero address). Absent when it could not be quoted. */
  fee?: bigint;
  /** The token the relay quoted the fee in (the zero address is native). Meaningful with `fee`. */
  feeToken: Address;
  /** Native value the leg's calls carry: KeyStore registration fees. */
  value: bigint;
  /**
   * Native wei this leg needs from its payer: the fee (when paid natively) plus the value the
   * calls carry, or the relay's own figure when it reports the payer as short.
   */
  needed: bigint;
  /** True when `needed` is the relay's own figure. */
  neededFromRelay: boolean;
  /**
   * Registry legs the relay funds from an L2: that chain. `needed` is then
   * charged to the payer's balance there, not on `chainId`.
   */
  fundedFromChainId?: number;
  /**
   * What this line takes from its payer, per chain and token.
   *
   * `needed` above is one native number, which only says everything while the
   * payer pays in the chain's native token. A registry leg the relay funds
   * from an L2 is charged on that L2 in whatever token the relay priced it in:
   * CELO, or a stablecoin with 6 decimals. This is the figure to check a
   * balance against; `needed` is its native part.
   */
  needs?: readonly QuoteNeed[];
  /**
   * What each of the relay's quoted legs charges, in that leg's own token on
   * its own chain. `fee` and `feeToken` are the charge on the chain the payer
   * pays from; this is every leg, including the registry chain's, which the
   * relay's funder pays and the escrow repays.
   */
  charges?: readonly LegCharge[];
  /**
   * Registry legs on a wallet's FIRST write: that write is two sequential
   * intents, so `fee`, `value` and `needed` above are the sum of both, and this
   * is the root (`initialRegisterKey`) intent's own share. Absent on every
   * later write, which is one intent.
   */
  rootRegistration?: Pick<QuoteLine, "fee" | "feeToken" | "value" | "needed" | "neededFromRelay" | "fundedFromChainId" | "needs" | "charges">;
  /**
   * The relay's quoted legs with their gas budgets, per leg. What decides
   * whether each fits; see `CallsQuote.legs`.
   */
  legs?: readonly QuoteLeg[];
  /** Why the fee could not be quoted. */
  reason?: string;
  /**
   * Cache legs on a first grant: the proof does not exist until the registry
   * write lands, so the leg is priced then. Not a failure.
   */
  deferred?: true;
};

/** A payer's balance of one token on one chain, against what the quoted lines take from it. */
export type QuoteBalance = {
  chainId: number;
  address: Address;
  /** The token this row is about (the zero address is the chain's native token). */
  token: Address;
  symbol: string;
  /** Decimals for `balance` and `needed`: 18 for a native token, the token's own otherwise. */
  decimals: number;
  balance: bigint;
  /** What the quoted lines need from this payer, in this token on this chain. */
  needed: bigint;
  sufficient: boolean;
  /**
   * Why the balance could not be read, when it could not. `balance` is then 0
   * and `sufficient` false, so a short answer is never reported as a safe one.
   */
  reason?: string;
};

export type SessionQuote = {
  lines: QuoteLine[];
  balances: QuoteBalance[];
  /**
   * False when a line carries no fee: the real cost is then higher than the
   * lines add up to. A first grant's cache legs are `deferred`, priced once
   * the registry write lands; any other fee-less line failed and says why.
   */
  complete: boolean;
};

/** Quote grantSession with the same arguments. */
export async function quoteGrantSession(
  wallet: Wallet,
  adminSigner: Signer,
  opts: GrantSessionOptions,
  config: GrantSessionConfig,
): Promise<SessionQuote> {
  const { deps, lines } = quotingDeps();
  const { onStatus: _ignored, ...quiet } = opts;
  await runGrantSession(wallet, adminSigner, { ...quiet, ...(quiet.populateCache === false ? {} : { populateCache: "await" }) }, config, deps);
  return withBalances(lines, config.networks);
}

/** Quote revokeSession with the same arguments. */
export async function quoteRevokeSession(
  wallet: Wallet,
  adminSigner: Signer,
  sessionOrPublicKey: Session | Hex,
  options: Omit<RevokeSessionOptions, "onStatus">,
): Promise<SessionQuote> {
  const { deps, lines } = quotingDeps();
  await runRevokeSession(wallet, adminSigner, sessionOrPublicKey, { ...options, populateCache: "await" }, deps);
  return withBalances(lines, options.networks);
}

/** Deps that read for real and quote every write, recording one line per leg. */
export function quotingDeps(base: SessionLegDeps = realSessionLegDeps): {
  deps: SessionLegDeps;
  lines: QuoteLine[];
} {
  const lines: QuoteLine[] = [];
  const sumValue = (calls: readonly Call[]) => calls.reduce((s, c) => s + (c.value ?? 0n), 0n);

  const deps: SessionLegDeps = {
    ...base,

    async submitAccountIntent(network, args) {
      const line: QuoteLine = {
        chainId: network.chainId,
        kind: "account",
        payer: args.wallet.address,
        feeToken: NATIVE_TOKEN,
        value: sumValue(args.calls),
        needed: sumValue(args.calls),
        neededFromRelay: false,
      };
      try {
        const q = await quoteCalls(buildRelayClient(network), args.wallet.address, args.adminSigner, args.calls, {
          ...(args.feeToken ? { feeToken: args.feeToken } : {}),
          submittingKey: { type: "secp256k1", publicKey: args.adminSigner.publicKey, role: "admin" },
          network,
          ...(args.authorizeKeys ? { authorizeKeys: args.authorizeKeys } : {}),
          ...(args.revokeKeys ? { revokeKeys: args.revokeKeys } : {}),
        });
        Object.assign(line, pickQuote(q));
      } catch (err) {
        line.reason = errorMessage(err);
      }
      lines.push(line);
      // Nothing is sent, so there is no block: a placeholder keeps the cache legs quoted.
      return { status: "CONFIRMED", ...(args.needBlockNumber ? { blockNumber: 0n } : {}) };
    },

    async submitRegistry(registry, args) {
      const via = registry.relayUrl ? "relay" : "eoa";
      const line: QuoteLine = {
        chainId: registry.chainId,
        kind: "registry",
        via,
        payer: args.wallet.address,
        feeToken: NATIVE_TOKEN,
        value: sumValue(args.calls),
        needed: sumValue(args.calls),
        neededFromRelay: false,
      };
      try {
        if (via === "relay") {
          const registryClient = buildPublicClient(registry);
          const relayClient = buildRelayClient(registry);
          const quoteOne = async (calls: readonly Call[], isRoot = false) => {
            const requiredFunds = await planRegistryFunding({
              registryClient,
              registry,
              walletAddress: args.wallet.address,
              adminPublicKey: args.adminSigner.publicKey,
              calls,
              ...(isRoot ? { skipFirstActionPrepend: true } : {}),
            });
            return quoteCalls(relayClient, args.wallet.address, args.adminSigner, calls, {
              feeToken: NATIVE_TOKEN,
              requiredFunds,
              submittingKey: { type: "secp256k1", publicKey: args.adminSigner.publicKey, role: "admin" },
              network: registry,
              ...(isRoot ? { skipFirstActionPrepend: true } : {}),
            });
          };
          // A wallet's first registry write is submitted as two sequential
          // intents (see submitRegistryWrite), so it costs two fees and must be
          // quoted as two. Quoting one would under-report the first-time path.
          const prepend = await buildFirstActionPrepend({
            publicClient: registryClient,
            network: registry,
            walletAddress: args.wallet.address,
            adminPublicKey: args.adminSigner.publicKey,
          });
          const q = await quoteOne(args.calls);
          Object.assign(line, pickQuote(q));
          if (prepend.length > 0) {
            const root = await quoteOne(prepend, true);
            line.fee = q.fee + root.fee;
            line.value = q.value + root.value;
            line.needed = q.nativeNeeded + root.nativeNeeded;
            line.neededFromRelay = q.nativeNeededFromRelay || root.nativeNeededFromRelay;
            line.needs = mergeNeeds(q.needs, root.needs);
            line.rootRegistration = pickQuote(root);
          }
        } else {
          const plan = planRegistryWrite(registry, args.adminSigner, args.wallet.address);
          if (plan.via !== "eoa") throw new Error("unreachable: relay-less registry planned via relay");
          line.payer = plan.account.address;
          const client = buildPublicClient(registry);
          const prepend = await buildFirstActionPrepend({
            publicClient: client,
            network: registry,
            walletAddress: args.wallet.address,
            adminPublicKey: args.adminSigner.publicKey,
          });
          const all = [...prepend, ...args.calls];
          const [gasPrice, gas] = await Promise.all([
            client.getGasPrice(),
            Promise.all(
              all.map((c) =>
                client.estimateGas({ account: plan.account.address, to: c.to, value: c.value ?? 0n, data: c.data ?? "0x" }),
              ),
            ),
          ]);
          line.fee = gas.reduce((s, g) => s + g, 0n) * gasPrice;
          line.value = sumValue(all);
          line.needed = line.fee + line.value;
        }
      } catch (err) {
        line.reason = errorMessage(err);
      }
      lines.push(line);
      return { via, status: "CONFIRMED", blockNumber: 0n };
    },

    async proveIntoCache(wallet, adminSigner, publicKey, network, _afterL1Block, feeToken) {
      const line: QuoteLine = {
        chainId: network.chainId,
        kind: "cache",
        payer: wallet.address,
        feeToken: NATIVE_TOKEN,
        value: 0n,
        needed: 0n,
        neededFromRelay: false,
      };
      try {
        if (network.registry?.kind !== "cached") throw new Error("not a cached network");
        const l1Client = buildPublicClient(network.registry.l1);
        const l2Client = buildPublicClient(network);
        // The proof needs a Keystore entry. The key's own once the registry
        // write has landed (revokes, re-grants); otherwise any key the wallet
        // already has there, which proves at the same cost; on a first grant
        // there is none yet and the leg is priced when the write lands.
        const active = await readActiveKeys(l1Client, network.registry.l1, wallet.address);
        if (active.length === 0) {
          line.deferred = true;
          lines.push(line);
          return { chainId: network.chainId, status: "CONFIRMED" };
        }
        const own = keccak256(publicKey);
        const provenKey = active.includes(own)
          ? publicKey
          : await readPublicKey(l1Client, network.registry.l1, wallet.address, active[0]!);
        const call = await buildPopulateKeyCall({
          l1Client,
          l2Client,
          l1KeyStore: network.registry.l1.keyStore,
          l2Cache: keyStoreCacheOf(network),
          user: wallet.address,
          publicKey: provenKey,
          anchor: await readL1Anchor(l2Client),
        });
        const q = await quoteCalls(
          buildRelayClient(network),
          wallet.address,
          adminSigner,
          [{ to: call.to, value: call.value, data: call.data }],
          {
            ...(feeToken ? { feeToken } : {}),
            submittingKey: { type: "secp256k1", publicKey: adminSigner.publicKey, role: "admin" },
            network,
          },
        );
        Object.assign(line, pickQuote(q));
      } catch (err) {
        line.reason = errorMessage(err);
      }
      lines.push(line);
      return { chainId: network.chainId, status: "CONFIRMED" };
    },

    waitForKeyVisible: async () => {},
    sleep: async () => {},
  };
  return { deps, lines };
}

/**
 * Balances per payer, chain and token against what the lines need. Exported for tests.
 *
 * A line's `needs` decides which balance is read: a registry leg the relay
 * funds from Celo and prices in USDC is checked against the payer's USDC
 * there, not against anyone's native balance. Lines with no `needs` — a direct
 * EOA registry write, or a leg that could not be quoted — keep the long-standing
 * behaviour: their `needed` is native on `fundedFromChainId ?? chainId`.
 */
export async function withBalances(
  lines: QuoteLine[],
  networks: readonly NetworkConfig[],
): Promise<SessionQuote> {
  const byChain = new Map<number, NetworkConfig>();
  for (const n of networks) {
    byChain.set(n.chainId, n);
    if (n.registry?.kind === "cached") byChain.set(n.registry.l1.chainId, n.registry.l1);
  }
  type Want = {
    chainId: number;
    address: Address;
    token: Address;
    amount: bigint;
    symbol?: string;
    decimals?: number;
  };
  const wants = new Map<string, Want>();
  const want = (w: Want) => {
    const key = `${w.chainId}:${w.token.toLowerCase()}:${w.address.toLowerCase()}`;
    const found = wants.get(key);
    if (!found) {
      wants.set(key, { ...w });
      return;
    }
    found.amount += w.amount;
    found.symbol ??= w.symbol;
    found.decimals ??= w.decimals;
  };
  for (const line of lines) {
    // A leg the relay funds from an L2 costs the payer on that chain.
    const fallbackChain = line.fundedFromChainId ?? line.chainId;
    if (!line.needs || line.needs.length === 0) {
      want({ chainId: fallbackChain, address: line.payer, token: NATIVE_TOKEN, amount: line.needed });
      continue;
    }
    for (const need of line.needs) {
      want({
        chainId: need.chainId ?? fallbackChain,
        address: line.payer,
        token: need.token,
        amount: need.amount,
        ...(need.symbol !== undefined ? { symbol: need.symbol } : {}),
        ...(need.decimals !== undefined ? { decimals: need.decimals } : {}),
      });
    }
  }
  const balances = await Promise.all(
    [...wants.values()].map(async (w): Promise<QuoteBalance> => {
      const network = byChain.get(w.chainId) ?? networkByChainId(w.chainId);
      if (!network) throw new Error(`quote: no network config for chain ${w.chainId}`);
      const client = buildPublicClient(network);
      if (w.token.toLowerCase() === NATIVE_TOKEN) {
        const balance = await client.getBalance({ address: w.address });
        return {
          chainId: w.chainId,
          address: w.address,
          token: NATIVE_TOKEN,
          symbol: network.chain.nativeCurrency.symbol,
          decimals: network.chain.nativeCurrency.decimals,
          balance,
          needed: w.amount,
          sufficient: balance >= w.amount,
        };
      }
      // An ERC-20 the relay priced the leg in: its own balance, symbol and
      // decimals, read on chain. A failed read reports short, with the reason.
      const [read] = await readTokenBalances(client, w.address, [w.token]);
      if (!read?.ok) {
        return {
          chainId: w.chainId,
          address: w.address,
          token: w.token,
          symbol: w.symbol ?? "",
          decimals: w.decimals ?? 0,
          balance: 0n,
          needed: w.amount,
          sufficient: false,
          reason: read?.ok === false ? read.error : `could not read ${w.token}`,
        };
      }
      return {
        chainId: w.chainId,
        address: w.address,
        token: w.token,
        symbol: read.symbol.length > 0 ? read.symbol : (w.symbol ?? ""),
        decimals: read.decimals,
        balance: read.raw,
        needed: w.amount,
        sufficient: read.raw >= w.amount,
      };
    }),
  );
  return { lines, balances, complete: lines.every((l) => l.fee !== undefined) };
}

/** The quote fields a line keeps: fee, value, and what the payer must hold. */
function pickQuote(
  q: CallsQuote,
): Pick<QuoteLine, "fee" | "feeToken" | "value" | "needed" | "neededFromRelay" | "fundedFromChainId" | "legs" | "needs" | "charges"> {
  return {
    ...(q.legs.length ? { legs: q.legs } : {}),
    ...(q.charges.length ? { charges: q.charges } : {}),
    fee: q.fee,
    feeToken: q.feeToken,
    value: q.value,
    needed: q.nativeNeeded,
    neededFromRelay: q.nativeNeededFromRelay,
    ...(q.needs.length ? { needs: q.needs } : {}),
    ...(q.fundedFromChainId !== undefined ? { fundedFromChainId: q.fundedFromChainId } : {}),
  };
}

/** The two intents of a first registry write, added per chain and token. */
function mergeNeeds(...sets: (readonly QuoteNeed[] | undefined)[]): readonly QuoteNeed[] {
  const out = new Map<string, QuoteNeed>();
  for (const set of sets) {
    for (const need of set ?? []) {
      const key = `${need.chainId ?? "?"}:${need.token.toLowerCase()}`;
      const found = out.get(key);
      if (!found) {
        out.set(key, { ...need });
        continue;
      }
      found.amount += need.amount;
      found.fromRelay = found.fromRelay || need.fromRelay;
      if (found.symbol === undefined && need.symbol !== undefined) found.symbol = need.symbol;
      if (found.decimals === undefined && need.decimals !== undefined) found.decimals = need.decimals;
    }
  }
  return [...out.values()];
}

/** A chain's name, for a log line. */
function chainName(chainId: number): string {
  return networkByChainId(chainId)?.chain.name ?? `chain ${chainId}`;
}

/** How a need reads: "29.4 CELO", or the raw amount when nothing names the token. */
function formatNeed(need: QuoteNeed, fallback: NetworkConfig | undefined): string {
  if (need.token.toLowerCase() === NATIVE_TOKEN) {
    const native = (need.chainId !== undefined ? networkByChainId(need.chainId) : fallback)?.chain.nativeCurrency;
    const decimals = need.decimals ?? native?.decimals;
    const symbol = need.symbol ?? native?.symbol;
    if (decimals === undefined || symbol === undefined) return `${need.amount}`;
    return `${formatUnits(need.amount, decimals)} ${symbol}`;
  }
  if (need.decimals === undefined) return `${need.amount} of token ${need.token}`;
  return `${formatUnits(need.amount, need.decimals)} ${need.symbol ?? need.token}`;
}

/**
 * A one-line human summary of a quote line, for logs.
 *
 * The fee is labelled in the token and on the chain it is actually charged on.
 * A registry leg the relay funds from an L2 is paid there, so a cross-asset
 * quote reads "pays 2.84 CELO on Celo Sepolia" rather than quietly labelling
 * a CELO amount with the registry chain's symbol.
 */
export function formatQuoteLine(line: QuoteLine, network: NetworkConfig): string {
  const symbol = network.chain.nativeCurrency.symbol;
  const decimals = network.chain.nativeCurrency.decimals;
  // The fee is charged on the chain the payer pays from, not on the leg's own.
  const feeNetwork = line.fundedFromChainId !== undefined ? networkByChainId(line.fundedFromChainId) : network;
  const feeNeed = line.needs?.find((n) => n.token.toLowerCase() === line.feeToken.toLowerCase());
  const fee =
    line.fee === undefined
      ? line.deferred
        ? "fee priced once the registry write lands"
        : `could not be quoted: ${line.reason ?? "no quote"}`
      : `fee ${formatNeed({ ...(feeNeed ?? {}), token: line.feeToken, amount: line.fee, fromRelay: false, ...(line.fundedFromChainId !== undefined ? { chainId: line.fundedFromChainId } : {}) }, feeNetwork)}`;
  const value = line.value > 0n ? `, value ${formatUnits(line.value, decimals)} ${symbol}` : "";
  const funded =
    line.fundedFromChainId !== undefined ? `, funded from ${chainName(line.fundedFromChainId)}` : "";
  // What the payer must hold, when that is not simply this chain's native
  // token. A line that carries only the legacy `needed` — a quote recorded
  // before `needs` existed, or one built by hand — still states its total,
  // read as the funding chain's native token, which is what `needed` meant.
  const needs =
    line.needs && line.needs.length > 0
      ? line.needs
      : line.fundedFromChainId !== undefined && line.needed > 0n
        ? [{ chainId: line.fundedFromChainId, token: NATIVE_TOKEN, amount: line.needed, fromRelay: line.neededFromRelay }]
        : [];
  const pays = needs
    .filter((n) => n.amount > 0n && (n.chainId !== line.chainId || n.token.toLowerCase() !== NATIVE_TOKEN))
    .map((n) => `pays ${formatNeed(n, feeNetwork)}${n.chainId !== undefined ? ` on ${chainName(n.chainId)}` : ""}`);
  return `chain ${line.chainId} ${line.kind}${line.via ? ` via ${line.via}` : ""}: ${fee}${value}${funded}${pays.length ? `, ${pays.join(", ")}` : ""}`;
}
