import {
  createClient,
  type Client,
  type ClientExecuteOptions,
  type ClientGrantSessionOptions,
  type ClientQuoteGrantSessionOptions,
  type ClientQuoteRevokeSessionOptions,
  type ClientRevokeSessionOptions,
  type ExecuteResult,
  type FeeCurrenciesResult,
  type GrantSessionResult,
  type HoldingsResult,
  type NetworkConfig,
  type RevokeSessionResult,
  type SessionQuote,
  type Signer,
} from "@altananetwork/sdk";
import type { Address } from "viem";
import { relayReason } from "./errors";
import { entry, type LogEntry } from "./log";

/** The slice of the SDK client the panels use. Tests provide a fake. */
export interface TestbenchClient {
  readonly chains: readonly NetworkConfig[];
  createWallet(signer: Signer): Promise<{ address: Address }>;
  holdings(wallet: Address, chainId: number): Promise<HoldingsResult>;
  feeCurrencies(chainId: number): Promise<FeeCurrenciesResult>;
  execute(opts: ClientExecuteOptions): Promise<ExecuteResult>;
  grantSession(opts: ClientGrantSessionOptions): Promise<GrantSessionResult>;
  quoteGrantSession(opts: ClientQuoteGrantSessionOptions): Promise<SessionQuote>;
  quoteRevokeSession(opts: ClientQuoteRevokeSessionOptions): Promise<SessionQuote>;
  revokeSession(opts: ClientRevokeSessionOptions): Promise<RevokeSessionResult>;
}

export type Logger = (e: LogEntry) => void;

/** Wraps the real SDK client; every call is logged with args, result or error. */
export function createLiveClient(chains: NetworkConfig[], log: Logger): TestbenchClient {
  const client: Client = createClient({ chains, defaultChainId: chains[0]?.chainId });

  async function call<T>(method: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      log(entry(method, { args, result }));
      return result;
    } catch (err) {
      log(entry(method, { args, error: relayReason(err), level: "error" }));
      throw err;
    }
  }

  return {
    chains,
    createWallet: (signer) =>
      call("createWallet", { signer: signer.address }, async () => {
        const w = await client.createWallet({ signer });
        return { address: w.address };
      }),
    holdings: (wallet, chainId) =>
      call("holdings", { wallet, chainId }, () => client.holdings({ wallet, chainId, includeZero: false })),
    feeCurrencies: (chainId) => call("feeCurrencies", { chainId }, () => client.feeCurrencies({ chainId })),
    execute: (opts) => call("execute", opts, () => client.execute(opts)),
    grantSession: (opts) => call("grantSession", opts, () => client.grantSession(opts)),
    quoteGrantSession: (opts) => call("quoteGrantSession", opts, () => client.quoteGrantSession(opts)),
    quoteRevokeSession: (opts) => call("quoteRevokeSession", opts, () => client.quoteRevokeSession(opts)),
    revokeSession: (opts) => call("revokeSession", opts, () => client.revokeSession(opts)),
  };
}
