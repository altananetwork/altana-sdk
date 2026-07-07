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
import type { PasskeySigner } from "./internal/passkey.js";
import type { Wallet, ExecuteResult } from "./internal/types.js";
import type { Session, GrantSessionOptions } from "./internal/sessions.js";
import type { Call } from "./internal/relay.js";
import {
  createWallet as createWalletImpl,
  type CreateWalletResult,
} from "./createWallet.js";
import { createPasskeyWallet as createPasskeyWalletImpl } from "./createPasskeyWallet.js";
import { recoverFromPasskey as recoverFromPasskeyImpl } from "./recoverFromPasskey.js";
import { execute as executeImpl } from "./execute.js";
import { grantSession as grantSessionImpl } from "./grantSession.js";
import { revokeSession as revokeSessionImpl } from "./revokeSession.js";
import { balances as balancesImpl, type BalancesResult } from "./balances.js";

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
    } & ChainSelector);

export type ClientGrantSessionOptions = {
  wallet: Wallet;
  signer: Signer;
  feeToken?: Address;
} & GrantSessionOptions &
  ChainSelector;

export type ClientRevokeSessionOptions = {
  wallet: Wallet;
  signer: Signer;
  session: Session | Hex;
  feeToken?: Address;
} & ChainSelector;

export type ClientBalancesOptions = {
  wallet: Wallet | Address;
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
  grantSession(opts: ClientGrantSessionOptions): Promise<Session>;
  revokeSession(opts: ClientRevokeSessionOptions): Promise<ExecuteResult>;
  balances(opts: ClientBalancesOptions): Promise<BalancesResult>;
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

    grantSession(o) {
      return grantSessionImpl(
        o.wallet,
        o.signer,
        {
          permissions: o.permissions,
          expiry: o.expiry,
          ...(o.sessionSigner ? { sessionSigner: o.sessionSigner } : {}),
        },
        {
          network: resolve(o.chainId),
          ...(o.feeToken ? { feeToken: o.feeToken } : {}),
        },
      );
    },

    revokeSession(o) {
      return revokeSessionImpl(o.wallet, o.signer, o.session, {
        network: resolve(o.chainId),
        ...(o.feeToken ? { feeToken: o.feeToken } : {}),
      });
    },

    balances(o) {
      return balancesImpl(o.wallet, { network: resolve(o.chainId) });
    },
  };
}
