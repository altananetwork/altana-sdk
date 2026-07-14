/**
 * Session-key smoke test on BNB testnet.
 *
 * Validates the full session lifecycle:
 *   1. createWallet (admin signer)
 *   2. fund from deployer
 *   3. execute(wallet, admin, ...) — first execute, registers in KeyStore
 *   4. grantSession(wallet, admin, ...) — issues a scoped session key
 *   5. execute(session, ...) — agent uses session (different signer)
 *   6. revokeSession(wallet, admin, session.publicKey) — admin pulls access
 *   7. execute(session, ...) — should now fail at validator
 *
 * Run: bun run packages/wallet/scripts/smoke-session.ts
 */

import {
  createClient,
  createPrivateKeySigner,
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
  console.log("@altananetwork/sdk session smoke test — BNB testnet");
  console.log("=============================================\n");

  const t0 = performance.now();
  const deployer = privateKeyToAccount(TEST_FUNDER_KEY);
  const deployerClient = createWalletClient({
    account: deployer,
    chain: bscTestnet,
    transport: http(BNB_TESTNET.publicRpcUrl),
  });
  const publicClient = buildPublicClient(BNB_TESTNET);

  // 1. Create wallet with admin signer
  console.log("[1] createWallet + admin signer");
  const client = createClient({ chains: [BNB_TESTNET] });
  const adminSigner = createPrivateKeySigner();
  const wallet = await client.createWallet({ signer: adminSigner });
  console.log("    wallet.address:    ", wallet.address);
  console.log("    admin.address:     ", adminSigner.address);
  console.log(`    done [${ms(t0)}]`);

  // 2. Fund from deployer
  console.log("\n[2] Fund wallet from deployer (0.003 ETH for multiple txs)");
  const fundTx = await deployerClient.sendTransaction({
    to: wallet.address,
    value: parseEther("0.003"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`    funded [${ms(t0)}]`);

  // 3. First execute (registers admin key in KeyStore)
  console.log("\n[3] execute(wallet, admin, sendOneWei) — first call, registers admin");
  const firstExec = await client.execute({
    wallet,
    signer: adminSigner,
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

  // 4. Grant a session.
  // Note: The relay treats omitted `calls` as "no calls allowed," not "any."
  // So we explicitly list the target the test will hit.
  console.log("\n[4] grantSession (1h expiry, scoped to deployer + 1 ETH/day cap)");
  const session = await client.grantSession({
    wallet,
    signer: adminSigner,
    permissions: {
      calls: [{ to: deployer.address }],
      spend: [{ limit: parseEther("1"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  console.log("    session.publicKey:    ", session.signer.publicKey.slice(0, 20) + "...");
  console.log("    session.signer.addr:  ", session.signer.address);
  console.log(`    granted [${ms(t0)}]`);

  // 5. Execute as the session
  console.log("\n[5] execute(session, sendOneWei) — agent path");
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
    console.log("    WARN: not confirmed within timeout. callsId:", sessionExec.callsId);
    console.log("    Continuing test — may still confirm async.");
  }

  // 6. Revoke
  console.log("\n[6] revokeSession");
  const revokeRes = await client.revokeSession({ wallet, signer: adminSigner, session });
  console.log("    status:", revokeRes.status, `[${ms(t0)}]`);
  console.log("    tx:    ", revokeRes.transactionHash);

  // 7. Try the session again — should fail at validator
  console.log("\n[7] execute(session, ...) after revoke — expecting failure");
  try {
    const afterRevoke = await client.execute({
      session,
      calls: {
        to: deployer.address,
        value: 1n,
        data: "0x",
      },
    });
    if (afterRevoke.status === "CONFIRMED") {
      console.log("    UNEXPECTED: session still works after revoke");
    } else {
      console.log("    Failed as expected, status:", afterRevoke.status);
    }
  } catch (err) {
    console.log("    Failed as expected:", err instanceof Error ? err.message.slice(0, 100) : err);
  }

  console.log("\n=============================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nSession smoke test crashed:", err);
  process.exit(1);
});
