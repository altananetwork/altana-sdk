/**
 * Browser-passkey wallet creation with recovery baked in.
 *
 * Sequencing matters: generate the throwaway-EOA first so we know the
 * wallet address before prompting for the passkey, then write that
 * address into the WebAuthn credential's `userHandle`. On any future
 * device, a discoverable-credential lookup returns the userHandle, which
 * is what `recoverFromPasskey` uses to find the wallet on-chain.
 *
 * Use this for real users in the browser. For tests / Node, use
 * `createWallet({ signer: createHeadlessPasskey() })` instead — the
 * headless path runs without an OS keychain.
 */

import {
  prepareUpgradeAccount,
  upgradeAccount,
} from "porto/viem/RelayActions";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import {
  buildRelayClient,
} from "./internal/relay.js";
import {
  createPasskey,
  passkeyToPortoKey,
  type PasskeySigner,
  type PasskeyWebAuthnFns,
} from "./internal/passkey.js";
import type { CreateWalletResult } from "./createWallet.js";

export type CreatePasskeyWalletOptions = {
  /** Label shown in the OS passkey prompt (e.g. "MyApp"). */
  name: string;
  /** Relying-Party ID. Defaults to the current origin's host. */
  rpId?: string;
  /** WebAuthn overrides for runtimes without the browser API (React Native etc.). */
  webAuthn?: PasskeyWebAuthnFns;
  /**
   * Chains to provision the wallet on. The same address is delegated on
   * each. Supplied by the client from its configured chain set.
   */
  networks: NetworkConfig[];
};

export async function createPasskeyWallet(
  opts: CreatePasskeyWalletOptions,
): Promise<CreateWalletResult & { signer: PasskeySigner }> {
  if (opts.networks.length === 0) {
    throw new Error("createPasskeyWallet: at least one network is required.");
  }

  // 1. Throwaway secp256k1. Its EOA address becomes the smart-account
  //    address. The key itself goes out of scope when this function returns
  //    — its only job is to sign the EIP-7702 setCode authorization on every
  //    configured chain. It must be reused across chains so the wallet
  //    address is the same everywhere.
  const throwawayPk = generatePrivateKey();
  const throwawayAccount = privateKeyToAccount(throwawayPk);
  const walletAddress: Address = throwawayAccount.address;

  // 2. Prompt the user for a passkey with walletAddress baked into the
  //    credential as userHandle. From this point on, ANY assertion from
  //    this passkey returns walletAddress — including on devices that
  //    have never seen this app before, via discoverable-credential lookup.
  const passkey = await createPasskey({
    ...(opts.webAuthn ? { webAuthn: opts.webAuthn } : {}),
    name: opts.name,
    ...(opts.rpId ? { rpId: opts.rpId } : {}),
    userId: walletAddress,
  });
  const passkeyAdminKey = passkeyToPortoKey(passkey, { role: "admin" });

  // 3. EIP-7702 upgrade on every configured chain. The throwaway signs each
  //    chain's authorization tuple; the passkey is registered as the smart
  //    account's admin authority. Counterfactual: the setCode lands as a
  //    preCall on each chain's first execute.
  for (const network of opts.networks) {
    const relayClient = buildRelayClient(network);
    const prepared: any = await prepareUpgradeAccount(relayClient, {
      address: walletAddress,
      authorizeKeys: [passkeyAdminKey],
    });
    const signatures: Record<string, Hex> = {};
    for (const [name, digest] of Object.entries(prepared.digests ?? {})) {
      signatures[name] = await throwawayAccount.sign({ hash: digest as Hex });
    }
    await upgradeAccount(relayClient as any, {
      context: prepared.context,
      signatures,
    } as any);
  }

  return {
    address: walletAddress,
    signer: passkey,
  };
}
