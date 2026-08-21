import {
  createWalletClient,
  http,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkConfig } from "../config.js";
import { hasRawPrivateKey, type Signer } from "./signer.js";

/**
 * Build a viem WalletClient that pays gas on `network`, from an SDK Signer.
 *
 * Used for the L2 `populateKey` proof submission, which must be a raw
 * transaction from a funded EOA (it is permissionless but costs L2 gas). A
 * passkey / injected signer cannot send a raw transaction, so this requires a
 * raw-private-key signer and fails loudly otherwise.
 *
 * Once the relay pays for `populateKey`, this and the gas signer go away.
 */
export function walletClientFromSigner(
  signer: Signer,
  network: NetworkConfig,
): WalletClient {
  if (!hasRawPrivateKey(signer)) {
    throw new Error(
      `The L2 gas payer for chain ${network.chainId} must be a raw private-key ` +
        `signer (it submits a plain populateKey transaction). A ${signer.type} ` +
        `signer cannot. Configure relayers[${network.chainId}] with ` +
        `signerFromPrivateKey(...).`,
    );
  }
  return createWalletClient({
    account: privateKeyToAccount(signer._privateKey),
    chain: network.chain,
    transport: http(network.publicRpcUrl),
  });
}
