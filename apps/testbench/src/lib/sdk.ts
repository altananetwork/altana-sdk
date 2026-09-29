import {
  createClient,
  type Client,
  type CallsQuote,
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
  type PasskeySigner,
  type RevokeSessionResult,
  type SessionQuote,
  type Signer,
  type SyncSessionToCacheResult,
} from "@altananetwork/sdk";
import type { Address, Hex } from "viem";
import { relayReason } from "./errors";
import { entry, type LogEntry } from "./log";
import type { MirrorReading } from "./mirror";
import { cachedNetworkFor, readMirror } from "./mirrorReads";

/** The slice of the SDK client the panels use. Tests provide a fake. */
export interface TestbenchClient {
  readonly chains: readonly NetworkConfig[];
  createWallet(signer: Signer): Promise<{ address: Address }>;
  /** Prompts WebAuthn for a fresh passkey and provisions one address on every configured chain. */
  createPasskeyWallet(opts: { name: string }): Promise<{ address: Address; signer: PasskeySigner }>;
  /** Finds the wallet from an existing passkey, with no stored state. */
  recoverFromPasskey(): Promise<{ address: Address; signer: PasskeySigner }>;
  holdings(wallet: Address, chainId: number): Promise<HoldingsResult>;
  feeCurrencies(chainId: number): Promise<FeeCurrenciesResult>;
  execute(opts: ClientExecuteOptions): Promise<ExecuteResult>;
  quoteExecute(opts: ClientExecuteOptions): Promise<CallsQuote>;
  grantSession(opts: ClientGrantSessionOptions): Promise<GrantSessionResult>;
  quoteGrantSession(opts: ClientQuoteGrantSessionOptions): Promise<SessionQuote>;
  quoteRevokeSession(opts: ClientQuoteRevokeSessionOptions): Promise<SessionQuote>;
  revokeSession(opts: ClientRevokeSessionOptions): Promise<RevokeSessionResult>;
  /** One reading of the Celo mirror, the anchor and the KeyStore slots behind it. */
  readMirror(opts: { chainId: number; user: Address; keyId: Hex }): Promise<MirrorReading>;
  /** Sends a populateKey proof for the current anchor, as a wallet call through the relay. */
  proveIntoMirror(opts: {
    chainId: number;
    wallet: Address;
    signer: Signer;
    publicKey: Hex;
  }): Promise<SyncSessionToCacheResult>;
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
    createPasskeyWallet: ({ name }) =>
      call("createPasskeyWallet", { name }, async () => {
        const w = await client.createPasskeyWallet({ name });
        return { address: w.address, signer: w.signer };
      }),
    recoverFromPasskey: () =>
      call("recoverFromPasskey", {}, async () => {
        const w = await client.recoverFromPasskey();
        return { address: w.address, signer: w.signer };
      }),
    holdings: (wallet, chainId) =>
      call("holdings", { wallet, chainId }, () => client.holdings({ wallet, chainId, includeZero: false })),
    feeCurrencies: (chainId) => call("feeCurrencies", { chainId }, () => client.feeCurrencies({ chainId })),
    execute: (opts) => call("execute", opts, () => client.execute(opts)),
    quoteExecute: (opts) => call("quoteExecute", opts, () => client.quoteExecute(opts)),
    grantSession: (opts) => call("grantSession", opts, () => client.grantSession(opts)),
    quoteGrantSession: (opts) => call("quoteGrantSession", opts, () => client.quoteGrantSession(opts)),
    quoteRevokeSession: (opts) => call("quoteRevokeSession", opts, () => client.quoteRevokeSession(opts)),
    revokeSession: (opts) => call("revokeSession", opts, () => client.revokeSession(opts)),
    readMirror: ({ chainId, user, keyId }) =>
      call("readMirror", { chainId, user, keyId }, () => {
        const network = cachedNetworkFor(chainId);
        if (!network) {
          throw new Error(
            `Chain ${chainId} keeps its KeyStore locally, so it has no Celo-style mirror to read.`,
          );
        }
        return readMirror({ network, user, keyId });
      }),
    proveIntoMirror: ({ chainId, wallet, signer, publicKey }) =>
      call("proveIntoMirror", { chainId, wallet, publicKey }, () =>
        client.syncSessionToCache({
          chainId,
          wallet: { address: wallet },
          signer,
          session: publicKey,
          // The anchor is already carrying the state the card checked, so the
          // proof goes against it now. One retry covers an anchor that moves
          // between the card's read and the relay's simulation.
          maxAttempts: 2,
          anchorSettleMs: 0,
        }),
      ),
  };
}
