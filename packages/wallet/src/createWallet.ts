import { type NetworkConfig } from "./config.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import {
  buildRelayClient,
  planAccountProvisioning,
  provisionAccount,
} from "./internal/relay.js";
import { provisioningNetworks } from "./internal/cachedRegistry.js";
import type { Wallet } from "./internal/types.js";

export type CreateWalletOptions = {
  /**
   * Signer for the wallet's admin authority. Bring your own via
   * signerFromPrivateKey / signerFromPasskey, or omit
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
 * Every signer type is multichain. The wallet's address and the key that
 * signs each chain's EIP-7702 authorization are decided once, before the
 * loop, so a passkey wallet gets one throwaway EOA for all of its chains
 * rather than one per chain. See `planAccountProvisioning`.
 *
 * A cached network whose registry chain has a relay (Celo, rooted in
 * Ethereum) is provisioned on that registry chain too: the wallet has the
 * same address and the same admin there, and its registry writes go through
 * its own smart account. A relay-less registry chain needs no provisioning;
 * writes there come from the admin EOA.
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

  // One plan for the whole wallet: the address every chain provisions, and
  // the key that signs every chain's authorization over it.
  const plan = planAccountProvisioning(signer);
  for (const network of provisioningNetworks(opts.networks)) {
    await provisionAccount(buildRelayClient(network), plan);
  }

  return {
    address: plan.walletAddress,
    signer,
  };
}
