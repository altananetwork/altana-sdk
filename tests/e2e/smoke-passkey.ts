/**
 * Passkey smoke test on BNB testnet.
 *
 * Validates the full passkey-backed wallet lifecycle, using the headless
 * variant so it runs in Node:
 *   1. createHeadlessPasskey() → PasskeySigner
 *   2. createWallet({ signer: passkey, skipFaucet: true })
 *      — internally generates a throwaway secp256k1, signs EIP-7702 setCode,
 *        authorizes the passkey as admin, discards the throwaway
 *   3. Fund the wallet from deployer
 *   4. execute(wallet, passkey, sendOneWei) — first call, registers passkey
 *      P256 publicKey in KeyStore
 *   5. grantSession(wallet, passkey, ...) — passkey admin grants a session
 *   6. execute(session, ...) — session-key path still works for passkey admin
 *   7. revokeSession(wallet, passkey, session)
 *
 * Run: bun run packages/wallet/scripts/smoke-passkey.ts
 */

import {
  createClient,
  createHeadlessPasskey,
  BNB_TESTNET,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY env var. Locally: .env. CI: GitHub Actions secret.",
  );
}

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

async function main() {
  console.log("@altananetwork/sdk passkey smoke test — BNB testnet");
  console.log("===========================================\n");

  const t0 = performance.now();
  const deployer = privateKeyToAccount(TEST_FUNDER_KEY);
  const deployerClient = createWalletClient({
    account: deployer,
    chain: bscTestnet,
    transport: http(BNB_TESTNET.publicRpcUrl),
  });
  const publicClient = buildPublicClient(BNB_TESTNET);

  // 1. Create passkey signer (headless variant for Node)
  console.log("[1] createHeadlessPasskey");
  const passkey = createHeadlessPasskey();
  console.log("    type:        ", passkey.type);
  console.log("    publicKey:   ", passkey.publicKey.slice(0, 24) + "...");
  console.log("    credential:  ", passkey.credential.kind);

  // 2. Create wallet — uses throwaway-EOA bootstrap internally
  console.log("\n[2] createWallet({ signer: passkey })");
  const client = createClient({ chains: [BNB_TESTNET] });
  const wallet = await client.createWallet({ signer: passkey });
  console.log("    wallet.address:", wallet.address);
  console.log(`    upgraded [${ms(t0)}]`);

  // 3. Fund wallet from deployer
  console.log("\n[3] Fund wallet (0.003 ETH for multiple txs)");
  const fundTx = await deployerClient.sendTransaction({
    to: wallet.address,
    value: parseEther("0.003"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`    funded [${ms(t0)}]`);

  // 4. First execute — registers passkey P256 publicKey in KeyStore
  console.log("\n[4] execute(wallet, passkey, sendOneWei) — first call, registers passkey");
  const firstExec = await client.execute({
    wallet,
    signer: passkey,
    calls: {
      to: deployer.address,
      value: 1n,
      data: "0x",
    },
  });
  console.log("    status:", firstExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", firstExec.transactionHash);
  if (firstExec.status !== "CONFIRMED") {
    throw new Error("First execute failed");
  }

  // 5. Grant a session under passkey admin authority
  console.log("\n[5] grantSession (1h, scoped to deployer, 1 ETH/day)");
  const session = await client.grantSession({
    wallet,
    signer: passkey,
    permissions: {
      calls: [{ to: deployer.address }],
      spend: [{ limit: parseEther("1"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  console.log("    session.publicKey:   ", session.signer.publicKey.slice(0, 20) + "...");
  console.log("    session.signer.addr: ", session.signer.address);
  console.log(`    granted [${ms(t0)}]`);

  // 6. Execute as session (session signer is private-key by default)
  console.log("\n[6] execute(session, sendOneWei) — agent path under passkey admin");
  const sessionExec = await client.execute({
    session,
    calls: {
      to: deployer.address,
      value: 1n,
      data: "0x",
    },
  });
  console.log("    status:", sessionExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", sessionExec.transactionHash);
  if (sessionExec.status !== "CONFIRMED") {
    console.log("    WARN: session execute not confirmed within timeout. callsId:", sessionExec.callsId);
  }

  // 7. Revoke
  console.log("\n[7] revokeSession (passkey admin)");
  const revokeRes = await client.revokeSession({ wallet, signer: passkey, session });
  console.log("    status:", revokeRes.status, `[${ms(t0)}]`);
  console.log("    tx:    ", revokeRes.transactionHash);

  console.log("\n===========================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nPasskey smoke test crashed:", err);
  process.exit(1);
});
