/**
 * Calls written for @altananetwork/sdk 0.9.0 still compile, unchanged.
 *
 * 0.9.0 granted and revoked on one chain, named with `chainId`, and both
 * calls returned the transaction hash. The shapes below are the ones a 0.9.0
 * integration uses. Checked by `bun run typecheck`.
 */
import type { Hex } from "viem";
import { serializeSession, type Client, type Session, type Signer, type Wallet } from "../src/index.js";

declare const client: Client;
declare const wallet: Wallet;
declare const signer: Signer;
declare const sessionSigner: Signer;
const chainId = 56;

export async function grantLikeV090(): Promise<{ session: Session; hash: Hex | undefined }> {
  const granted = await client.grantSession({
    wallet,
    signer,
    permissions: { calls: [{ to: wallet.address }], spend: [{ limit: 1n, period: "day" }] },
    expiry: 1_800_000_000,
    sessionSigner,
    register: true,
    feeToken: "0x0000000000000000000000000000000000000000",
    chainId,
  });
  const hash: Hex | undefined = granted.transactionHash;
  // The result is still a Session.
  const session: Session = granted;
  void serializeSession(granted);
  return { session, hash };
}

export async function revokeLikeV090(session: Session): Promise<Hex | null> {
  const res = await client.revokeSession({ wallet, signer, session, chainId });
  // 0.9.0 returned an ExecuteResult here, and callers compared its status.
  if (res.status === "FAILED") {
    throw new Error(`The revoke did not confirm (relay code ${res.statusCode ?? "unknown"}).`);
  }
  const byPublicKey = await client.revokeSession({
    wallet,
    signer,
    session: session.publicKey,
    feeToken: "0x0000000000000000000000000000000000000000",
  });
  void byPublicKey.transactionHash;
  return res.transactionHash ?? null;
}
