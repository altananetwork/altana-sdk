import { type NetworkConfig } from "./config.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import {
  buildRelayClient,
  registerAccount,
} from "./internal/relay.js";
import type { Address } from "viem";
import type { Wallet } from "./internal/types.js";

export type CreateWalletOptions = {
  /**
   * Signer for the wallet's admin authority. Bring your own via
   * signerFromPrivateKey / signerFromInjected / signerFromPasskey, or omit
   * to let the SDK generate a fresh private-key signer (returned via
   * the optional `signer` field on the result).
   */
  signer?: Signer;
  /**
   * Chains to provision the wallet on. The same address is set up on each.
   * Supplied by the client from its configured chain set.
   */
  networks: NetworkConfig[];
};

export type CreateWalletResult = Wallet & {
  /**
   * The signer used for this wallet. If the caller supplied one, this is the
   * same reference. If the SDK generated one, this is how the caller gets
   * access to it — persist it however their app stores keys.
   */
  signer: Signer;
};

/**
 * Creates a smart-account wallet for a signer across one or more chains.
 *
 * Steps:
 *   1. Use the supplied signer, or generate a fresh private-key signer
 *   2. For each configured chain, register the signer's address with that
 *      chain's relay as a smart account (counterfactual; no on-chain tx).
 *      The same wallet address is delegated on every chain.
 *   3. Return the wallet handle + signer reference
 *
 * The wallet is NOT yet registered in KeyStore on any chain — that happens
 * on the first execute() call per chain, batched with the user's intent.
 *
 * The caller is responsible for funding the wallet address before the first
 * on-chain action.
 *
 * Multichain only works for signers that yield a deterministic address
 * across chains (private-key signers). For passkeys across chains, use
 * createPasskeyWallet, which reuses a single throwaway EOA.
 *
 * Custody follows the signer. Altana never persists keys.
 */
export async function createWallet(
  opts: CreateWalletOptions,
): Promise<CreateWalletResult> {
  if (opts.networks.length === 0) {
    throw new Error("createWallet: at least one network is required.");
  }
  const signer = opts.signer ?? createPrivateKeySigner();

  let walletAddress: Address | undefined;
  for (const network of opts.networks) {
    const relayClient = buildRelayClient(network);
    const { walletAddress: addr } = await registerAccount(relayClient, signer);
    if (walletAddress && addr !== walletAddress) {
      throw new Error(
        `createWallet: signer produced a different address on chain ` +
          `${network.chainId} (${addr}) than on the first chain ` +
          `(${walletAddress}). Multichain createWallet needs a signer with a ` +
          `deterministic address; use createPasskeyWallet for passkeys.`,
      );
    }
    walletAddress = addr;
  }

  return {
    address: walletAddress!,
    signer,
  };
}
