/**
 * Compile-time contract of the session API: one chain by default, several
 * with `chainIds`. Checked by
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

// Revoke acts on every chain the client has. `chainId` names the chain the
// call answers for; it does not narrow the revoke.
void client.revokeSession({ wallet, signer, session });
void client.revokeSession({
  wallet,
  signer,
  session,
  feeToken: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000001"],
});
void client.revokeSession({ wallet, signer, session, chainId: 56 });
// @ts-expect-error revoke has no chainIds: it already reaches every chain
void client.revokeSession({ wallet, signer, session, chainIds: [56] });

// The low-level function takes networks, not a single network.
void revokeSession(wallet, signer, session, { networks: [BNB] });
// @ts-expect-error `network` was replaced by `networks`
void revokeSession(wallet, signer, session, { network: BNB });

// Grant goes to one chain: the default chain, or the one named by chainId.
void client.grantSession({ wallet, signer, permissions: {}, expiry: 0 });
void client.grantSession({ wallet, signer, permissions: {}, expiry: 0, chainId: 56 });
// Several chains in one call with chainIds.
void client.grantSession({ wallet, signer, permissions: {}, expiry: 0, chainIds: [56, 1] });
// @ts-expect-error chainId and chainIds together are refused
void client.grantSession({ wallet, signer, permissions: {}, expiry: 0, chainId: 56, chainIds: [56] });
// The quote takes the same selector.
void client.quoteGrantSession({ wallet, signer, permissions: {}, expiry: 0 });
void client.quoteGrantSession({ wallet, signer, permissions: {}, expiry: 0, chainId: 56 });
void client.quoteGrantSession({ wallet, signer, permissions: {}, expiry: 0, chainIds: [56, 1] });
// @ts-expect-error chainId and chainIds together are refused on the quote too
void client.quoteGrantSession({ wallet, signer, permissions: {}, expiry: 0, chainId: 56, chainIds: [56] });
// @ts-expect-error a quote takes no progress callback
void client.quoteGrantSession({ wallet, signer, permissions: {}, expiry: 0, onStatus: () => {} });
void grantSession(wallet, signer, { permissions: {}, expiry: 0 }, { networks: [BNB] });

// The status is binary.
const done: RevokeSessionResult["status"] = "revoked";
// @ts-expect-error there is no partial status
const partial: RevokeSessionResult["status"] = "partial";
void done;
void partial;
void createClient;
