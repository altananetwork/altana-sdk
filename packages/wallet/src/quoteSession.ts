/**
 * What a multi-chain grant or revoke would cost, before running it.
 *
 * The quote runs the same planning as grantSession and revokeSession (the
 * same discovery reads, the same legs, the same bundling), with every write
 * replaced by a quote: the relay's `prepareCalls` for relayed legs, a gas
 * estimate for direct registry transactions. Nothing is signed or sent.
 */

import { formatUnits, type Address, type Hex } from "viem";
import { NATIVE_TOKEN, type NetworkConfig } from "./config.js";
import { planRegistryWrite, keyStoreCacheOf } from "./internal/cachedRegistry.js";
import { buildFirstActionPrepend } from "./internal/keystore.js";
import { buildPublicClient, buildRelayClient, quoteCalls, type Call } from "./internal/relay.js";
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
  /** Why the fee could not be quoted. */
  reason?: string;
};

/** A payer's native balance on one chain, against what the quoted lines ask of it. */
export type QuoteBalance = {
  chainId: number;
  address: Address;
  symbol: string;
  balance: bigint;
  /** Native wei the quoted lines need from this payer on this chain (fees in native plus values). */
  required: bigint;
  sufficient: boolean;
};

export type SessionQuote = {
  lines: QuoteLine[];
  balances: QuoteBalance[];
  /** False when any line could not be quoted: the real cost is then higher than the lines add up to. */
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
  await runGrantSession(wallet, adminSigner, quiet, config, deps);
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
  await runRevokeSession(wallet, adminSigner, sessionOrPublicKey, options, deps);
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
      };
      try {
        const q = await quoteCalls(buildRelayClient(network), args.wallet.address, args.adminSigner, args.calls, {
          ...(args.feeToken ? { feeToken: args.feeToken } : {}),
          submittingKey: { type: "secp256k1", publicKey: args.adminSigner.publicKey, role: "admin" },
          network,
          ...(args.authorizeKeys ? { authorizeKeys: args.authorizeKeys } : {}),
          ...(args.revokeKeys ? { revokeKeys: args.revokeKeys } : {}),
        });
        line.fee = q.fee;
        line.feeToken = q.feeToken;
        line.value = q.value;
      } catch (err) {
        line.reason = errorMessage(err);
      }
      lines.push(line);
      return { status: "CONFIRMED" };
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
      };
      try {
        if (via === "relay") {
          const q = await quoteCalls(buildRelayClient(registry), args.wallet.address, args.adminSigner, args.calls, {
            feeToken: NATIVE_TOKEN,
            submittingKey: { type: "secp256k1", publicKey: args.adminSigner.publicKey, role: "admin" },
            network: registry,
          });
          line.fee = q.fee;
          line.value = q.value;
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
        }
      } catch (err) {
        line.reason = errorMessage(err);
      }
      lines.push(line);
      return { via, status: "CONFIRMED" };
    },

    async proveIntoCache(wallet, adminSigner, publicKey, network, _afterL1Block, feeToken) {
      const line: QuoteLine = {
        chainId: network.chainId,
        kind: "cache",
        payer: wallet.address,
        feeToken: NATIVE_TOKEN,
        value: 0n,
      };
      try {
        if (network.registry?.kind !== "cached") throw new Error("not a cached network");
        const l2Client = buildPublicClient(network);
        const call = await buildPopulateKeyCall({
          l1Client: buildPublicClient(network.registry.l1),
          l2Client,
          l1KeyStore: network.registry.l1.keyStore,
          l2Cache: keyStoreCacheOf(network),
          user: wallet.address,
          publicKey,
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
        line.fee = q.fee;
        line.feeToken = q.feeToken;
      } catch (err) {
        // The proof can only be simulated against registry state that
        // exists; before the registry write lands the relay may refuse it.
        line.reason = `cache proof could not be quoted ahead of the registry write: ${errorMessage(err)}`;
      }
      lines.push(line);
      return { chainId: network.chainId, status: "CONFIRMED" };
    },

    waitForKeyVisible: async () => {},
    sleep: async () => {},
  };
  return { deps, lines };
}

async function withBalances(
  lines: QuoteLine[],
  networks: readonly NetworkConfig[],
): Promise<SessionQuote> {
  const byChain = new Map<number, NetworkConfig>();
  for (const n of networks) {
    byChain.set(n.chainId, n);
    if (n.registry?.kind === "cached") byChain.set(n.registry.l1.chainId, n.registry.l1);
  }
  const required = new Map<string, { chainId: number; address: Address; wei: bigint }>();
  for (const line of lines) {
    const key = `${line.chainId}:${line.payer.toLowerCase()}`;
    const entry = required.get(key) ?? { chainId: line.chainId, address: line.payer, wei: 0n };
    entry.wei += line.value + (line.feeToken === NATIVE_TOKEN ? (line.fee ?? 0n) : 0n);
    required.set(key, entry);
  }
  const balances = await Promise.all(
    [...required.values()].map(async ({ chainId, address, wei }): Promise<QuoteBalance> => {
      const network = byChain.get(chainId)!;
      const balance = await buildPublicClient(network).getBalance({ address });
      return {
        chainId,
        address,
        symbol: network.chain.nativeCurrency.symbol,
        balance,
        required: wei,
        sufficient: balance >= wei,
      };
    }),
  );
  return { lines, balances, complete: lines.every((l) => l.fee !== undefined) };
}

/** A one-line human summary of a quote line, for logs. */
export function formatQuoteLine(line: QuoteLine, network: NetworkConfig): string {
  const symbol = network.chain.nativeCurrency.symbol;
  const fee =
    line.fee === undefined
      ? `fee unknown (${line.reason ?? "not quoted"})`
      : line.feeToken === NATIVE_TOKEN
        ? `fee ${formatUnits(line.fee, network.chain.nativeCurrency.decimals)} ${symbol}`
        : `fee ${line.fee} of token ${line.feeToken}`;
  const value = line.value > 0n ? `, value ${formatUnits(line.value, network.chain.nativeCurrency.decimals)} ${symbol}` : "";
  return `chain ${line.chainId} ${line.kind}${line.via ? ` via ${line.via}` : ""}: ${fee}${value}`;
}
