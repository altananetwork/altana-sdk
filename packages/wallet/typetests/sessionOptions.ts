/**
 * Compile-time contract of the multi-chain session API. Checked by
 * `bun run typecheck` (tsconfig.typetests.json); every @ts-expect-error below
 * must stay an error, or tsc fails on the unused directive.
 */
import {
  createClient,
  revokeSession,
  grantSession,
  BNB,
  type Client,
  type RevokeSessionResult,
  type Signer,
  type Wallet,
} from "../src/index.js";

declare const client: Client;
declare const wallet: Wallet;
declare const signer: Signer;
const session = "0x04" as `0x${string}`;

// Revoke acts on every chain the client has: no per-chain selector.
void client.revokeSession({ wallet, signer, session });
void client.revokeSession({
  wallet,
  signer,
  session,
  feeToken: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000001"],
});
// @ts-expect-error chainId was removed from revoke options
void client.revokeSession({ wallet, signer, session, chainId: 56 });

// The low-level function takes networks, not a single network.
void revokeSession(wallet, signer, session, { networks: [BNB] });
// @ts-expect-error `network` was replaced by `networks`
void revokeSession(wallet, signer, session, { network: BNB });

// Grant picks chains with chainIds.
void client.grantSession({ wallet, signer, permissions: {}, expiry: 0, chainIds: [56] });
// @ts-expect-error chainId was replaced by chainIds on grant options
void client.grantSession({ wallet, signer, permissions: {}, expiry: 0, chainId: 56 });
void grantSession(wallet, signer, { permissions: {}, expiry: 0 }, { networks: [BNB] });

// The status is binary.
const done: RevokeSessionResult["status"] = "revoked";
// @ts-expect-error there is no partial status
const partial: RevokeSessionResult["status"] = "partial";
void done;
void partial;
void createClient;
