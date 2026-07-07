/**
 * Verifies that a wallet whose FIRST on-chain action is grantSession (not
 * execute) still gets its admin key registered in KeyStore. This is the
 * exact failure mode that broke recover-from-passkey in the browser demo.
 *
 * Run: bun run packages/wallet/scripts/smoke-grant-first.ts
 */

import {
  createClient,
  createHeadlessPasskey,
  SEPOLIA,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { readActiveKeys, readPublicKey } from "../../packages/wallet/src/internal/keystore.js";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY env var. Locally: .env. CI: GitHub Actions secret.",
  );
}

async function main() {
  console.log("smoke-grant-first — admin registers via grantSession");
  console.log("====================================================\n");

  const publicClient = buildPublicClient(SEPOLIA);
  const deployer = privateKeyToAccount(TEST_FUNDER_KEY);
  const deployerClient = createWalletClient({
    account: deployer,
    chain: sepolia,
    transport: http(SEPOLIA.publicRpcUrl),
  });

  const client = createClient({ chains: [SEPOLIA] });
  const passkey = createHeadlessPasskey();
  const wallet = await client.createWallet({ signer: passkey });
  console.log("wallet:", wallet.address);

  const fundTx = await deployerClient.sendTransaction({
    to: wallet.address,
    value: parseEther("0.003"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log("funded");

  // Sanity: before grant, no keys registered yet.
  const before = await readActiveKeys(publicClient, SEPOLIA, wallet.address);
  console.log("KeyStore active keys before:", before.length);
  if (before.length !== 0) throw new Error("Unexpected: keys already registered");

  // First action: grantSession (NOT execute).
  console.log("\ngrantSession (this MUST register the admin in KeyStore)…");
  const session = await client.grantSession({
    wallet,
    signer: passkey,
    permissions: {
      calls: [{ to: deployer.address }],
      spend: [{ limit: parseEther("1"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  console.log("session granted:", session.signer.publicKey.slice(0, 20) + "…");

  const after = await readActiveKeys(publicClient, SEPOLIA, wallet.address);
  console.log("KeyStore active keys after:", after.length);
  // grantSession registers BOTH the admin (auto-prepended on first action)
  // AND the session in the same userOp, so we expect exactly 2.
  if (after.length !== 2) {
    throw new Error(`FAIL: expected 2 keys in KeyStore, got ${after.length}`);
  }

  // Find the admin entry among the two.
  const passkeyPubkey = ("0x" + passkey.publicKey.slice(2)).toLowerCase();
  let adminFound = false;
  for (const keyId of after) {
    const pk = await readPublicKey(publicClient, SEPOLIA, wallet.address, keyId as Hex);
    if (pk.toLowerCase() === passkeyPubkey) {
      adminFound = true;
      console.log("admin publicKey on-chain:", pk.slice(0, 20) + "…");
      break;
    }
  }
  if (!adminFound) {
    throw new Error("FAIL: admin passkey publicKey not found among registered keys");
  }

  console.log("\n====================================================");
  console.log("Result: PASS ✓ — first-action registration works for grantSession");
}

main().catch((err) => {
  console.error("\nCrashed:", err);
  process.exit(1);
});
