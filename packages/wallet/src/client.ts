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
import {
  type NetworkConfig,
  type L2CacheConfig,
  isGatedL2Chain,
  keyStoreOf,
} from "./config.js";
import type { Signer } from "./internal/signer.js";
import {
  grantSessionCrossChain as grantSessionCrossChainImpl,
  type GrantCrossChainStatus,
} from "./grantSessionCrossChain.js";
import { buildPublicClient } from "./internal/relay.js";
import { ensureKeyCached, type EnsureKeyCachedStatus } from "./syncKeyToL2.js";
import { walletClientFromSigner } from "./internal/gasPayer.js";
import type { PasskeySigner } from "./internal/passkey.js";
import type { Wallet, ExecuteResult } from "./internal/types.js";
import type {
  Session,
  GrantSessionOptions,
  GrantSessionResult,
} from "./internal/sessions.js";
import type { Call } from "./internal/relay.js";
import {
  createWallet as createWalletImpl,
  type CreateWalletResult,
} from "./createWallet.js";
import { createPasskeyWallet as createPasskeyWalletImpl } from "./createPasskeyWallet.js";
import { recoverFromPasskey as recoverFromPasskeyImpl } from "./recoverFromPasskey.js";
import { execute as executeImpl } from "./execute.js";
import { grantSession as grantSessionImpl } from "./grantSession.js";
import {
  wireSessionToGateOnL2 as wireSessionToGateImpl,
  type WireSessionToGateResult,
} from "./linkSessionToGate.js";
import { revokeSession as revokeSessionImpl } from "./revokeSession.js";
import { registerSessionKey as registerSessionKeyImpl } from "./registerSessionKey.js";
import type { RegisterSessionKeyResult } from "./registerSessionKey.js";
import { balances as balancesImpl, type BalancesResult } from "./balances.js";
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
  /**
   * Funded gas payers per chainId, for the L2 proof bridge (`populateKey`) that
   * a gated-L2 grant/execute performs internally. Only needed for gated L2
   * chains (e.g. Base Sepolia). Must be raw private-key signers — the proof is
   * submitted as a plain transaction. Removed once the relay pays for it.
   */
  relayers?: Record<number, Signer>;
};

/** Per-operation chain selector. Omit to use the client's default chain. */
type ChainSelector = { chainId?: number };

export type ClientCreateWalletOptions = {
  signer?: Signer;
};

export type ClientCreatePasskeyWalletOptions = {
  name: string;
  rpId?: string;
};

export type ClientRecoverFromPasskeyOptions = {
  rpId?: string;
} & ChainSelector;

export type ClientExecuteOptions =
  | ({
      wallet: Wallet;
      signer: Signer;
      calls: Call | readonly Call[];
      feeToken?: Address;
      noWait?: boolean;
    } & ChainSelector)
  | ({
      session: Session;
      calls: Call | readonly Call[];
      feeToken?: Address;
      noWait?: boolean;
      /**
       * On a gated L2, bridge the L1 proof into the cache before executing
       * (default true) so the gate can validate. Set false if you bridged
       * already. No effect on full-stack chains.
       */
      autoBridge?: boolean;
    } & ChainSelector);

export type ClientGrantSessionOptions = {
  wallet: Wallet;
  signer: Signer;
  feeToken?: Address;
  /** Gated L2 only: also bridge the L1 proof into the cache (default true). */
  bridge?: boolean;
  /** Gated L2 only: override the client-level relayer gas payer for this call. */
  l2GasSigner?: Signer;
  /** Gated L2 only: progress callback across register → wire → bridge → done. */
  onStatus?: (status: GrantCrossChainStatus) => void;
} & GrantSessionOptions &
  ChainSelector;

export type ClientWireSessionToGateOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session;
  gate: Address;
  target: Address;
  feeToken?: Address;
} & ChainSelector;

export type ClientRevokeSessionOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session | Hex;
  feeToken?: Address;
} & ChainSelector;

export type ClientRegisterSessionKeyOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session;
  feeToken?: Address;
} & ChainSelector;

export type ClientBalancesOptions = {
  wallet: Wallet | Address;
  /** ERC-20 tokens to include. BEP-677 display scaling is applied automatically. */
  tokens?: readonly Address[];
} & ChainSelector;

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
  grantSession(opts: ClientGrantSessionOptions): Promise<GrantSessionResult>;
  /**
   * Perform the first admin action on an L2 for a gated session: authorize the
   * key on the L2 account, bound it, route `target` through the gate, and link
   * it to the L1 keyId — one relay intent, passkey-compatible admin. Call this
   * on the L2 after granting the session on the L1.
   */
  wireSessionToGate(
    opts: ClientWireSessionToGateOptions,
  ): Promise<WireSessionToGateResult>;
  revokeSession(opts: ClientRevokeSessionOptions): Promise<ExecuteResult>;
  /** Lazily register a session key granted with `register: false`. Idempotent. */
  registerSessionKey(
    opts: ClientRegisterSessionKeyOptions,
  ): Promise<RegisterSessionKeyResult>;
  balances(opts: ClientBalancesOptions): Promise<BalancesResult>;

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

  const relayers = opts.relayers ?? {};

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

  /** Locate the L1 registry config for a gated L2, from this client's chains. */
  function resolveL1(l2: L2CacheConfig & { l1ChainId: number }): NetworkConfig {
    const l1 = byId.get(l2.l1ChainId);
    if (!l1) {
      throw new Error(
        `Chain ${l2.chainId} anchors to L1 chain ${l2.l1ChainId}, which is not ` +
          `configured on this client. Add its config (e.g. SEPOLIA) to ` +
          `createClient({ chains: [...] }). Configured: ${[...byId.keys()].join(", ")}.`,
      );
    }
    return l1;
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
      });
    },

    recoverFromPasskey(o = {}) {
      return recoverFromPasskeyImpl({
        network: resolve(o.chainId),
        ...(o.rpId ? { rpId: o.rpId } : {}),
      });
    },

    async execute(o) {
      const network = resolve(o.chainId);
      const execOpts = {
        network,
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        ...(o.noWait ? { noWait: o.noWait } : {}),
      };
      if (!("session" in o)) {
        return executeImpl(o.wallet, o.signer, o.calls, execOpts);
      }

      // Full-stack chain or explicit opt-out: execute directly.
      if (!isGatedL2Chain(network) || o.autoBridge === false) {
        return executeImpl(o.session, o.calls, execOpts);
      }

      // Gated L2: bridge the L1 proof (idempotent) before executing, and retry
      // through the ~12s L1-anchor race. A warm cache returns cache-hit fast.
      const l1 = resolveL1(network);
      const gasSigner = relayers[network.chainId];
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (gasSigner) {
            await ensureKeyCached({
              l1Client: buildPublicClient(l1),
              l2Client: buildPublicClient(network),
              l2WalletClient: walletClientFromSigner(gasSigner, network),
              l1KeyStore: keyStoreOf(l1),
              l2Cache: network.keyStoreCache,
              user: o.session.walletAddress,
              publicKey: o.session.publicKey,
            });
          }
          return await executeImpl(o.session, o.calls, execOpts);
        } catch (e) {
          lastErr = e;
          const msg = String(e);
          // Anchor moved / gate not yet valid: re-prove and retry.
          if (
            attempt < 2 &&
            (msg.includes("anchor") ||
              msg.includes("UnauthorizedCall") ||
              msg.includes("populateKey"))
          ) {
            await new Promise((r) => setTimeout(r, 4000));
            continue;
          }
          throw e;
        }
      }
      throw lastErr;
    },

    grantSession(o) {
      const network = resolve(o.chainId);
      const grantOpts = {
        permissions: o.permissions,
        expiry: o.expiry,
        ...(o.sessionSigner ? { sessionSigner: o.sessionSigner } : {}),
        ...(o.register !== undefined ? { register: o.register } : {}),
      };

      if (!isGatedL2Chain(network)) {
        return grantSessionImpl(o.wallet, o.signer, grantOpts, {
          network,
          ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        });
      }

      // Gated L2: the SDK does grant(L1) + wire(L2) + bridge under one call.
      return grantSessionCrossChainImpl(o.wallet, o.signer, grantOpts, {
        l2Network: network,
        l1Network: resolveL1(network),
        bridge: o.bridge !== false,
        ...(o.l2GasSigner ?? relayers[network.chainId]
          ? { l2GasSigner: o.l2GasSigner ?? relayers[network.chainId] }
          : {}),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        ...(o.onStatus ? { onStatus: o.onStatus } : {}),
      });
    },

    wireSessionToGate(o) {
      return wireSessionToGateImpl(o.wallet, o.signer, o.session, {
        network: resolve(o.chainId),
        gate: o.gate,
        target: o.target,
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    revokeSession(o) {
      return revokeSessionImpl(o.wallet, o.signer, o.session, {
        network: resolve(o.chainId),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    registerSessionKey(o) {
      return registerSessionKeyImpl(o.wallet, o.signer, o.session, {
        network: resolve(o.chainId),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    balances(o) {
      return balancesImpl(o.wallet, {
        network: resolve(o.chainId),
        ...(o.tokens !== undefined ? { tokens: o.tokens } : {}),
      });
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
