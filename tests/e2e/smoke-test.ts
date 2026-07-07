/**
 * Smoke test for @altananetwork/sdk on Sepolia.
 *
 * Validates the post-Signer-refactor public API end-to-end:
 *   1. createPrivateKeySigner() — generates an in-memory ECDSA signer
 *   2. createWallet({ signer, skipFaucet: true }) — registers w/ Porto
 *   3. Fund the new wallet from the Altana deployer wallet (direct ETH)
 *   4. execute(wallet, signer, sendOneWeiBack) — first execute, so SDK
 *      prepends KeyStoreController.initialRegisterKey atomically
 *   5. balances(wallet) + KeyStore.getActiveKeys verification
 *
 * Run:  bun run packages/wallet/scripts/smoke-test.ts
 */

import {
  createClient,
  createPrivateKeySigner,
  SEPOLIA,
} from "@altananetwork/sdk";
import { readActiveKeys } from "../../packages/wallet/src/internal/keystore.js";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

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
  console.log("@altananetwork/sdk smoke test — Sepolia (post-Signer refactor)");
  console.log("============================================================\n");

  const t0 = performance.now();
  const deployer = privateKeyToAccount(TEST_FUNDER_KEY);
  const deployerClient = createWalletClient({
    account: deployer,
    chain: sepolia,
    transport: http(SEPOLIA.publicRpcUrl),
  });
  const publicClient = buildPublicClient(SEPOLIA);

  console.log("Deployer:", deployer.address);
  const deployerBal = await publicClient.getBalance({ address: deployer.address });
  console.log("Deployer balance:", deployerBal.toString(), "wei");
  console.log();

  // Step 1+2: create the signer + wallet
  console.log("[1] createPrivateKeySigner() + createWallet({ signer, skipFaucet: true })");
  const client = createClient({ chains: [SEPOLIA] });
  const signer = createPrivateKeySigner();
  console.log("    signer.type:    ", signer.type);
  console.log("    signer.address: ", signer.address, `[${ms(t0)}]`);

  const wallet = await client.createWallet({ signer });
  console.log("    wallet.address: ", wallet.address, `[${ms(t0)}]`);
  console.log("    wallet.chainId: ", SEPOLIA.chainId);
  // Sanity: same address everywhere
  if (wallet.address !== signer.address) {
    throw new Error("Wallet/signer address mismatch — bug in refactor");
  }

  // Step 3: fund from deployer
  console.log("\n[2] Fund wallet from deployer");
  const fundTx = await deployerClient.sendTransaction({
    to: wallet.address,
    value: parseEther("0.002"),
  });
  console.log(`    fund tx: ${fundTx} [${ms(t0)}]`);
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`    confirmed [${ms(t0)}]`);

  const keysBefore = await readActiveKeys(publicClient, SEPOLIA, wallet.address);
  console.log("    KeyStore.getActiveKeys before:", keysBefore.length);

  // Step 4: execute (first call prepends KeyStore registration)
  console.log("\n[3] execute (first call → prepends KeyStore registration)");
  const result = await client.execute({
    wallet,
    signer,
    calls: {
      to: deployer.address,
      value: 1n,
      data: "0x",
    },
  });
  console.log("    callsId:        ", result.callsId);
  console.log("    status:         ", result.status, `[${ms(t0)}]`);
  console.log("    transactionHash:", result.transactionHash ?? "(none)");

  // Step 5: verify
  console.log("\n[4] Verify");
  const keysAfter = await readActiveKeys(publicClient, SEPOLIA, wallet.address);
  console.log("    KeyStore.getActiveKeys after: ", keysAfter.length);
  if (keysAfter.length > 0) {
    console.log("    Registered keyId:             ", keysAfter[0]);
  }
  const finalBal = await client.balances({ wallet });
  console.log("    Final native balance:         ", finalBal.native.toString(), "wei");

  console.log("\n============================================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  const pass = result.status === "CONFIRMED" && keysAfter.length === 1;
  console.log("Result:", pass ? "PASS ✓" : "PARTIAL");
  if (result.transactionHash) {
    console.log("\nEtherscan:");
    console.log(`  https://sepolia.etherscan.io/tx/${result.transactionHash}`);
    console.log(`  https://sepolia.etherscan.io/address/${wallet.address}`);
  }
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
