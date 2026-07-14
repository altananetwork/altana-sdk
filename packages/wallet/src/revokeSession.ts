import { keccak256, type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import {
  buildPublicClient,
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";
import { buildRevokeKeyCall, readIsValidKey } from "./internal/keystore.js";
import type { Session } from "./internal/sessions.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * Revoke a session key from a wallet on-chain. After confirmation, the
 * session's next execute attempt fails at validator level.
 *
 * Accepts either a Session object or just the session's public key when
 * you've persisted the session metadata in your app.
 */
export async function revokeSession(
  wallet: Wallet,
  adminSigner: Signer,
  sessionOrPublicKey: Session | Hex,
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<ExecuteResult> {
  const network = config.network;
  const feeToken = config.feeToken ?? NATIVE_TOKEN;

  const sessionPublicKey =
    typeof sessionOrPublicKey === "string"
      ? sessionOrPublicKey
      : sessionOrPublicKey.publicKey;

  const sessionKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: sessionPublicKey,
    role: "session",
  };

  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  const relayClient = buildRelayClient(network);
  const publicClient = buildPublicClient(network);

  // Revoke in KeyStore alongside revoking on Porto. KeyStore is the
  // public registry — leaving a revoked session there would be a stale
  // record that other tools would still treat as active. Both ops land in
  // the same userOp. Revocation is monotonic in v1.0.0.
  //
  // Gated on the key actually being registered: sessions granted with
  // `register: false` have no KeyStore entry, and revoking a missing keyId
  // would revert — taking the account-level revoke (the one that removes the
  // session's authority) down with it, since the bundle is atomic.
  const keyId = keccak256(sessionPublicKey);
  const isRegistered = await readIsValidKey(
    publicClient,
    network,
    wallet.address,
    keyId,
  );
  const revokeCalls = isRegistered
    ? [buildRevokeKeyCall({ walletAddress: wallet.address, keyId, network })]
    : [];

  const callsId = await submitCalls(
    relayClient,
    wallet.address,
    adminSigner,
    revokeCalls,
    {
      feeToken,
      submittingKey: adminKeyDesc,
      revokeKeys: [sessionKeyDesc],
      network,
    },
  );

  const result = await waitForCalls(relayClient, callsId);
  return {
    callsId,
    status: result.status as ExecuteResult["status"],
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}
