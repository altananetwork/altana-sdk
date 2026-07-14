import { type Address } from "viem";
import { type NetworkConfig } from "./config.js";
import type { Signer } from "./internal/signer.js";
import {
  buildPublicClient,
  buildRelayClient,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";
import {
  buildAdditionalRegisterCall,
  deriveKeyId,
  readIsValidKey,
  readRegistrationFee,
} from "./internal/keystore.js";
import type { Session } from "./internal/sessions.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/** Result of registerSessionKey. `alreadyRegistered: true` = nothing to do, no fee paid. */
export type RegisterSessionKeyResult =
  | { alreadyRegistered: true }
  | ({ alreadyRegistered: false } & ExecuteResult);

/**
 * Register an already-granted session key in the KeyStore registry — the lazy
 * counterpart to `grantSession({ register: false })`.
 *
 * Registration is what makes the key verifiable by third parties: after it
 * confirms, any tool reading the registry (e.g. `verify_authorization`) sees
 * the session's authority, expiry, and revocation state on-chain. It changes
 * nothing about the session's power — the account authorization from the
 * grant already enforces permissions/expiry — it only makes the key visible.
 *
 * Idempotent: if the key is already registered (and valid), returns
 * `{ alreadyRegistered: true }` without submitting anything or paying the fee.
 */
export async function registerSessionKey(
  wallet: Wallet,
  adminSigner: Signer,
  session: Session,
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<RegisterSessionKeyResult> {
  const network = config.network;
  const feeToken = config.feeToken ?? NATIVE_TOKEN;

  const publicClient = buildPublicClient(network);
  const keyId = deriveKeyId(session.publicKey);

  const alreadyRegistered = await readIsValidKey(
    publicClient,
    network,
    wallet.address,
    keyId,
  );
  if (alreadyRegistered) return { alreadyRegistered: true };

  // Registry entry only — the account authorization already exists from the
  // grant, so no authorizeKeys here. The registry expiry mirrors the
  // account's so the two never disagree about when the key dies.
  const fee = await readRegistrationFee(publicClient, network);
  const registerCall = buildAdditionalRegisterCall({
    publicKey: session.publicKey,
    fee,
    network,
    expiry: session.expiry,
  });

  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  const relayClient = buildRelayClient(network);
  const callsId = await submitCalls(
    relayClient,
    wallet.address,
    adminSigner,
    [registerCall],
    {
      feeToken,
      submittingKey: adminKeyDesc,
      network,
    },
  );

  const result = await waitForCalls(relayClient, callsId);
  return {
    alreadyRegistered: false,
    callsId,
    status: result.status as ExecuteResult["status"],
    ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
  };
}
