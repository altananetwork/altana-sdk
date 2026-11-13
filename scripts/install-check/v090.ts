/**
 * Code written for @altananetwork/sdk 0.9.0, the shape real integrations use:
 * one client over two chains, a grant and a revoke that name their chain, the
 * transaction hash read off each result, and failure handled with try/catch.
 * It is compiled, never run. If a release stops accepting it, an integrator's
 * upgrade breaks the same way.
 */
import {
  BNB,
  ETHEREUM,
  createClient,
  deserializeSession,
  serializeSession,
  signerFromPrivateKey,
  type NetworkConfig,
  type SessionPermissions,
} from "@altananetwork/sdk";

const chains: NetworkConfig[] = [BNB, ETHEREUM];
const client = createClient({ chains, defaultChainId: BNB.chainId });

export async function grantUseRevoke(adminKey: `0x${string}`, permissions: SessionPermissions) {
  const signer = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer });

  let granted;
  try {
    granted = await client.grantSession({
      wallet,
      signer,
      permissions,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      chainId: BNB.chainId,
    });
  } catch (err) {
    if (err instanceof Error && /status=PENDING/.test(err.message)) return undefined;
    throw err;
  }
  const grantTx: `0x${string}` | undefined = granted.transactionHash;

  const stored = serializeSession(granted);
  const session = deserializeSession(stored, granted.signer);
  const sent = await client.execute({
    session,
    calls: [{ to: wallet.address, value: 0n, data: "0x" }],
    chainId: BNB.chainId,
  });

  const res = await client.revokeSession({ wallet, signer, session, chainId: BNB.chainId });
  if (res.status === "FAILED") throw new Error("revoke failed");
  const revokeTx: `0x${string}` | undefined = res.transactionHash;

  return { grantTx, executeTx: sent.transactionHash, revokeTx };
}
