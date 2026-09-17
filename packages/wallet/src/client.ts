/**
 * The wallet client. A client is configured with the chains it supports;
 * every wallet it creates is set up on each of those chains under the same
 * address, and every operation targets one of them by chainId.
 *
 * This mirrors Porto's model (Porto.create({ chains })): pick your chains
 * once, then select a chain per operation. A wallet is not bound to a single
 * chain — the smart-account address is identical on every EVM chain.
 */

import type { Address, Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import type { PasskeySigner, PasskeyWebAuthnFns } from "./internal/passkey.js";
import type { Wallet, ExecuteResult } from "./internal/types.js";
import type {
  Session,
  GrantSessionOptions,
  GrantSessionResult,
} from "./internal/sessions.js";
import type { Call, CallsQuote } from "./internal/relay.js";
import {
  createWallet as createWalletImpl,
  type CreateWalletResult,
} from "./createWallet.js";
import { createPasskeyWallet as createPasskeyWalletImpl } from "./createPasskeyWallet.js";
import { recoverFromPasskey as recoverFromPasskeyImpl } from "./recoverFromPasskey.js";
import { execute as executeImpl, quoteExecute as quoteExecuteImpl } from "./execute.js";
import { feeCurrencies as feeCurrenciesImpl, type FeeCurrenciesResult } from "./feeCurrencies.js";
import { grantSession as grantSessionImpl } from "./grantSession.js";
import { revokeSession as revokeSessionImpl } from "./revokeSession.js";
import { registerSessionKey as registerSessionKeyImpl } from "./registerSessionKey.js";
import type { RegisterSessionKeyResult } from "./registerSessionKey.js";
import type { RevokeSessionOptions, RevokeSessionResult } from "./revokeSession.js";
import {
  quoteGrantSession as quoteGrantSessionImpl,
  quoteRevokeSession as quoteRevokeSessionImpl,
  type SessionQuote,
} from "./quoteSession.js";
import {
  syncSessionToCache as syncSessionToCacheImpl,
  type SyncSessionToCacheOptions,
  type SyncSessionToCacheResult,
} from "./syncSessionToCache.js";
import { balances as balancesImpl, type BalancesResult } from "./balances.js";
import { holdings as holdingsImpl, type HoldingsResult } from "./holdings.js";
import {
  signOrder as signOrderImpl,
  signOrderTypedData as signOrderTypedDataImpl,
} from "./signOrder.js";
import {
  approveSignatureChecker as approveSignatureCheckerImpl,
  revokeSignatureChecker as revokeSignatureCheckerImpl,
} from "./approveSignatureChecker.js";
import { approveTokenForPermit2 as approveTokenForPermit2Impl } from "./approveTokenForPermit2.js";
import { fetchWithX402 as fetchWithX402Impl } from "./x402.js";
import type { FetchWithX402Options } from "./x402.js";

export type CreateClientOptions = {
  /**
   * Chains this client supports. Pass one for a single-L1 setup, or several
   * to make wallets usable across all of them. The same wallet address works
   * on every chain listed here.
   */
  chains: NetworkConfig[];
  /**
   * chainId used when an operation omits one. Defaults to the first chain in
   * `chains`. Must be one of the configured chains.
   */
  defaultChainId?: number;
};

/** Per-operation chain selector. Omit to use the client's default chain. */
type ChainSelector = { chainId?: number };

export type ClientCreateWalletOptions = {
  signer?: Signer;
};

export type ClientCreatePasskeyWalletOptions = {
  name: string;
  rpId?: string;
  /** Browser: omit. Native mobile app (React Native etc.): required — see PasskeyWebAuthnFns. */
  webAuthn?: PasskeyWebAuthnFns;
};

export type ClientRecoverFromPasskeyOptions = {
  rpId?: string;
  /** Browser: omit. Native mobile app (React Native etc.): required — see PasskeyWebAuthnFns. */
  webAuthn?: PasskeyWebAuthnFns;
} & ChainSelector;

export type ClientExecuteOptions =
  | ({
      wallet: Wallet;
      signer: Signer;
      calls: Call | readonly Call[];
      /** One token to force, or a list to pay with the first accepted and held. */
      feeToken?: Address | readonly Address[];
      noWait?: boolean;
    } & ChainSelector)
  | ({
      session: Session;
      calls: Call | readonly Call[];
      feeToken?: Address | readonly Address[];
      noWait?: boolean;
    } & ChainSelector);

export type ClientGrantSessionOptions = {
  wallet: Wallet;
  signer: Signer;
  /**
   * The fee token(s) for the grant itself, and the tokens the session may pay
   * fees in: each gets a daily spend cap added to the session's permissions
   * (see `feeSpendLimit`). One address or a list.
   */
  feeToken?: Address | readonly Address[];
  /** The chains to grant on. Defaults to every chain the client was configured with. */
  chainIds?: readonly number[];
  chainId?: never;
} & GrantSessionOptions;

/**
 * Revokes on every chain the client was configured with: the SDK finds the
 * chains whose account holds the key. There is no per-chain selector.
 */
export type ClientRevokeSessionOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session | Hex;
  /** One token to force, or a list to pay with the first accepted and held. */
  feeToken?: Address | readonly Address[];
  onStatus?: RevokeSessionOptions["onStatus"];
  chainId?: never;
};

export type ClientQuoteGrantSessionOptions = Omit<ClientGrantSessionOptions, "onStatus">;
export type ClientQuoteRevokeSessionOptions = Omit<ClientRevokeSessionOptions, "onStatus">;

export type ClientRegisterSessionKeyOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session;
  /** One token to force, or a list to pay with the first accepted and held. */
  feeToken?: Address | readonly Address[];
} & ChainSelector;

/**
 * L2 only: prove a session key's registry state into the L2 KeyStoreCache. See syncSessionToCache.
 */
export type ClientSyncSessionToCacheOptions = {
  wallet: Wallet;
  /** The wallet's admin signer; the proof is a wallet call it signs. */
  signer: Signer;
  session: Session | Hex;
} & Omit<SyncSessionToCacheOptions, "network"> &
  ChainSelector;

export type ClientBalancesOptions = {
  wallet: Wallet | Address;
  /** ERC-20 tokens to include. BEP-677 display scaling is applied automatically. */
  tokens?: readonly Address[];
} & ChainSelector;

export type ClientHoldingsOptions = {
  wallet: Wallet | Address;
  /** Keep tokens the relay lists but whose live balance is zero. Default false. */
  includeZero?: boolean;
} & ChainSelector;

export type ClientFeeCurrenciesOptions = ChainSelector;

export type ClientApproveSignatureCheckerOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session;
  checker: Address;
  feeToken?: Address;
} & ChainSelector;

export type ClientApproveTokenForPermit2Options = {
  wallet: Wallet;
  signer: Signer;
  token: Address;
  amount?: bigint;
  feeToken?: Address;
} & ChainSelector;

export type ClientFetchWithX402Options = {
  session: Session;
  url: string;
  init?: RequestInit;
  /** Preferred rail when a chain offers several (defaults to "permit2"). */
  preferRail?: FetchWithX402Options["preferRail"];
} & ChainSelector;

export type Client = {
  /** The chains this client was configured with. */
  readonly chains: readonly NetworkConfig[];
  /** chainId used when an operation omits one. */
  readonly defaultChainId: number;

  createWallet(opts?: ClientCreateWalletOptions): Promise<CreateWalletResult>;
  createPasskeyWallet(
    opts: ClientCreatePasskeyWalletOptions,
  ): Promise<CreateWalletResult & { signer: PasskeySigner }>;
  recoverFromPasskey(
    opts?: ClientRecoverFromPasskeyOptions,
  ): Promise<CreateWalletResult & { signer: PasskeySigner }>;
  execute(opts: ClientExecuteOptions): Promise<ExecuteResult>;
  /** What `execute` would be charged for these calls, from the relay's quote; nothing is signed or sent. */
  quoteExecute(opts: ClientExecuteOptions): Promise<CallsQuote>;
  /** Grant a session on every chain in `chainIds` (default: all of the client's chains). */
  grantSession(opts: ClientGrantSessionOptions): Promise<GrantSessionResult>;
  /** Revoke a session everywhere it lives across the client's chains. */
  revokeSession(opts: ClientRevokeSessionOptions): Promise<RevokeSessionResult>;
  /** What grantSession would cost, one line per leg, plus the balances that pay it. */
  quoteGrantSession(opts: ClientQuoteGrantSessionOptions): Promise<SessionQuote>;
  /** What revokeSession would cost, one line per leg, plus the balances that pay it. */
  quoteRevokeSession(opts: ClientQuoteRevokeSessionOptions): Promise<SessionQuote>;
  /** Lazily register a session key granted with `register: false`. Idempotent. */
  registerSessionKey(
    opts: ClientRegisterSessionKeyOptions,
  ): Promise<RegisterSessionKeyResult>;
  /**
   * L2 only: prove a session key's registry entry (or
   * revocation) into the network's KeyStoreCache as a wallet call through
   * the network's relay. grantSession and revokeSession do this themselves;
   * call it to retry a proof they reported as failed, or after
   * `populateCache: false`.
   */
  syncSessionToCache(
    opts: ClientSyncSessionToCacheOptions,
  ): Promise<SyncSessionToCacheResult>;
  balances(opts: ClientBalancesOptions): Promise<BalancesResult>;
  /**
   * Discover which tokens the wallet holds on a chain. Asks the Altana relay
   * for the wallet's assets, then reads each one live (BEP-677 aware).
   */
  holdings(opts: ClientHoldingsOptions): Promise<HoldingsResult>;
  /**
   * The tokens the relay accepts as payment for its fee on a chain, read
   * live, with the rate each is priced at. Omit `feeToken` on any call and
   * the relay charges whichever of these the wallet holds.
   */
  feeCurrencies(opts?: ClientFeeCurrenciesOptions): Promise<FeeCurrenciesResult>;

  /** Sign a protocol digest with a session key (offline, chain-independent). */
  signOrder(opts: { session: Session; appDigest: Hex }): Promise<Hex>;
  signOrderTypedData(opts: {
    session: Session;
    typedData: Parameters<typeof signOrderTypedDataImpl>[1];
  }): Promise<Hex>;
  approveSignatureChecker(
    opts: ClientApproveSignatureCheckerOptions,
  ): Promise<ExecuteResult>;
  revokeSignatureChecker(
    opts: ClientApproveSignatureCheckerOptions,
  ): Promise<ExecuteResult>;
  approveTokenForPermit2(
    opts: ClientApproveTokenForPermit2Options,
  ): Promise<ExecuteResult>;
  /** fetch() that transparently pays x402 challenges with the session key. */
  fetchWithX402(opts: ClientFetchWithX402Options): Promise<Response>;
};

/**
 * Create a wallet client for one or more chains.
 *
 * @example
 * const client = createClient({ chains: [ETHEREUM, BNB] });
 * const wallet = await client.createPasskeyWallet({ name: "MyApp" });
 * await client.execute({ wallet, signer: wallet.signer, chainId: 56, calls });
 */
export function createClient(opts: CreateClientOptions): Client {
  const chains = opts.chains;
  if (!chains || chains.length === 0) {
    throw new Error("createClient: at least one chain is required.");
  }

  const byId = new Map<number, NetworkConfig>();
  for (const chain of chains) {
    if (byId.has(chain.chainId)) {
      throw new Error(
        `createClient: duplicate chainId ${chain.chainId} in chains.`,
      );
    }
    byId.set(chain.chainId, chain);
  }

  const defaultChainId = opts.defaultChainId ?? chains[0]!.chainId;
  if (!byId.has(defaultChainId)) {
    throw new Error(
      `createClient: defaultChainId ${defaultChainId} is not one of the ` +
        `configured chains (${[...byId.keys()].join(", ")}).`,
    );
  }

  function resolve(chainId?: number): NetworkConfig {
    const id = chainId ?? defaultChainId;
    const network = byId.get(id);
    if (!network) {
      throw new Error(
        `Chain ${id} is not configured on this client. Configured chains: ` +
          `${[...byId.keys()].join(", ")}.`,
      );
    }
    return network;
  }

  function grantNetworks(chainIds?: readonly number[]): NetworkConfig[] {
    return chainIds ? chainIds.map((id) => resolve(id)) : [...chains];
  }

  function grantOptions(o: ClientGrantSessionOptions): GrantSessionOptions {
    return {
      permissions: o.permissions,
      expiry: o.expiry,
      ...(o.sessionSigner ? { sessionSigner: o.sessionSigner } : {}),
      ...(o.register !== undefined ? { register: o.register } : {}),
      ...(o.populateCache !== undefined ? { populateCache: o.populateCache } : {}),
      ...(o.onStatus ? { onStatus: o.onStatus } : {}),
      ...(o.feeSpendLimit !== undefined ? { feeSpendLimit: o.feeSpendLimit } : {}),
    };
  }

  return {
    chains,
    defaultChainId,

    createWallet(o = {}) {
      return createWalletImpl({
        networks: [...chains],
        ...(o.signer ? { signer: o.signer } : {}),
      });
    },

    createPasskeyWallet(o) {
      return createPasskeyWalletImpl({
        name: o.name,
        networks: [...chains],
        ...(o.rpId ? { rpId: o.rpId } : {}),
        ...(o.webAuthn ? { webAuthn: o.webAuthn } : {}),
      });
    },

    recoverFromPasskey(o = {}) {
      return recoverFromPasskeyImpl({
        network: resolve(o.chainId),
        ...(o.rpId ? { rpId: o.rpId } : {}),
        ...(o.webAuthn ? { webAuthn: o.webAuthn } : {}),
      });
    },

    execute(o) {
      const execOpts = {
        network: resolve(o.chainId),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        ...(o.noWait ? { noWait: o.noWait } : {}),
      };
      if ("session" in o) {
        return executeImpl(o.session, o.calls, execOpts);
      }
      return executeImpl(o.wallet, o.signer, o.calls, execOpts);
    },

    quoteExecute(o) {
      const quoteOpts = { network: resolve(o.chainId), ...(o.feeToken ? { feeToken: o.feeToken } : {}) };
      if ("session" in o) return quoteExecuteImpl(o.session, o.calls, quoteOpts);
      return quoteExecuteImpl(o.wallet, o.signer, o.calls, quoteOpts);
    },

    grantSession(o) {
      return grantSessionImpl(o.wallet, o.signer, grantOptions(o), {
        networks: grantNetworks(o.chainIds),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    revokeSession(o) {
      return revokeSessionImpl(o.wallet, o.signer, o.session, {
        networks: chains,
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        ...(o.onStatus ? { onStatus: o.onStatus } : {}),
      });
    },

    quoteGrantSession(o) {
      return quoteGrantSessionImpl(o.wallet, o.signer, grantOptions(o), {
        networks: grantNetworks(o.chainIds),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    quoteRevokeSession(o) {
      return quoteRevokeSessionImpl(o.wallet, o.signer, o.session, {
        networks: chains,
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    registerSessionKey(o) {
      return registerSessionKeyImpl(o.wallet, o.signer, o.session, {
        network: resolve(o.chainId),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    syncSessionToCache(o) {
      const { wallet, signer, session, chainId, ...rest } = o;
      return syncSessionToCacheImpl(wallet, signer, session, {
        network: resolve(chainId),
        ...rest,
      });
    },

    balances(o) {
      return balancesImpl(o.wallet, {
        network: resolve(o.chainId),
        ...(o.tokens !== undefined ? { tokens: o.tokens } : {}),
      });
    },

    holdings(o) {
      return holdingsImpl(o.wallet, {
        network: resolve(o.chainId),
        ...(o.includeZero !== undefined ? { includeZero: o.includeZero } : {}),
      });
    },

    feeCurrencies(o = {}) {
      return feeCurrenciesImpl({ network: resolve(o.chainId) });
    },

    signOrder(o) {
      return signOrderImpl(o.session, o.appDigest);
    },

    signOrderTypedData(o) {
      return signOrderTypedDataImpl(o.session, o.typedData);
    },

    approveSignatureChecker(o) {
      return approveSignatureCheckerImpl(
        o.wallet,
        o.signer,
        { session: o.session, checker: o.checker },
        {
          network: resolve(o.chainId),
          ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        },
      );
    },

    revokeSignatureChecker(o) {
      return revokeSignatureCheckerImpl(
        o.wallet,
        o.signer,
        { session: o.session, checker: o.checker },
        {
          network: resolve(o.chainId),
          ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        },
      );
    },

    approveTokenForPermit2(o) {
      return approveTokenForPermit2Impl(o.wallet, o.signer, o.token, {
        network: resolve(o.chainId),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        ...(o.amount !== undefined ? { amount: o.amount } : {}),
      });
    },

    fetchWithX402(o) {
      // The client is chain-aware: default the x402 chain to its own so a
      // multi-chain 402 is paid on the right chain, and honor an override.
      return fetchWithX402Impl(o.session, o.url, o.init, {
        chainId: o.chainId ?? defaultChainId,
        ...(o.preferRail ? { preferRail: o.preferRail } : {}),
      });
    },
  };
}
