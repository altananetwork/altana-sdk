/**
 * Passkey smoke test on Celo Sepolia (chain 11142220), headless variant so it
 * runs in Node:
 *   1. createHeadlessPasskey() -> PasskeySigner
 *   2. createWallet({ signer: passkey }): throwaway secp256k1 signs the
 *      EIP-7702 setCode, the passkey becomes the admin authority
 *   3. fund the wallet with CELO
 *   4. execute(wallet, passkey, sendOneWei): the P256 signature is verified
 *      by the account through the P256 canary on Celo Sepolia
 *   5. grantSession(wallet, passkey, { register: false }): account-only
 *      session. Registry writes for passkey wallets are out of scope on this
 *      testnet: Sepolia has no relay, and a P256 admin cannot sign a direct
 *      Sepolia transaction. The account still enforces permissions/expiry.
 *      (The script also asserts that a registered grant throws the
 *      documented error instead of doing something else.)
 *   6. execute(session, ...): the session-key path under a passkey admin
 *   7. revokeSession(wallet, passkey, session): account revoke; registry and
 *      cache steps are reported as skipped
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY   funded with CELO on Celo Sepolia (>= 0.2 CELO,
 *                     https://faucet.celo.org/celo-sepolia)
 *   CELO_SEPOLIA_RPC_URL  optional override of the Celo Sepolia read RPC
 *
 * Run: bun run smoke:celo-passkey   (from tests/e2e)
 */

import {
  createClient,
  createHeadlessPasskey,
  CELO_SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia (https://faucet.celo.org/celo-sepolia).",
  );
}

const celoSepolia: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}
function show(v: unknown) {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
}

async function main() {
  console.log("@altananetwork/sdk passkey smoke test: Celo Sepolia");
  console.log("==================================================\n");

  const t0 = performance.now();
  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const celoPublic = createPublicClient({ chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const celoFunder = createWalletClient({ account: funder, chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const bal = await celoPublic.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(bal)} CELO on Celo Sepolia`);
  if (bal < parseEther("0.2")) {
    throw new Error(`Fund ${funder.address} with at least 0.2 CELO on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
  }

  // 1. Passkey signer (headless for Node)
  console.log("\n[1] createHeadlessPasskey");
  const passkey = createHeadlessPasskey();
  console.log("    type:        ", passkey.type);
  console.log("    publicKey:   ", passkey.publicKey.slice(0, 24) + "...");

  // 2. Wallet: throwaway-EOA bootstrap, passkey as admin
  console.log("\n[2] createWallet({ signer: passkey })");
  const client = createClient({ chains: [celoSepolia] });
  const wallet = await client.createWallet({ signer: passkey });
  console.log("    wallet.address:", wallet.address);
  console.log(`    upgraded [${ms(t0)}]`);

  // 3. Fund
  console.log("\n[3] Fund the wallet with 0.1 CELO");
  const fundTx = await celoFunder.sendTransaction({ to: wallet.address, value: parseEther("0.1") });
  await celoPublic.waitForTransactionReceipt({ hash: fundTx });
  console.log(`    funded [${ms(t0)}]`);

  // 4. First execute: P256 signature verified on Celo Sepolia (P256 canary)
  console.log("\n[4] execute(wallet, passkey, sendOneWei)");
  const firstExec = await client.execute({ wallet, signer: passkey, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", firstExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", firstExec.transactionHash);
  if (firstExec.status !== "CONFIRMED") throw new Error("First execute failed");

  // 5a. A registered grant must throw the documented error (no relay on Sepolia, P256 admin).
  console.log("\n[5a] grantSession with register: true must refuse (passkey admin, relay-less registry chain)");
  let refused = "";
  try {
    await client.grantSession({
      wallet,
      signer: passkey,
      permissions: { calls: [{ to: funder.address }] },
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  if (!/passkey \(P256\) admin cannot sign one/.test(refused)) {
    throw new Error(`expected the documented passkey refusal, got: ${refused.slice(0, 200) || "no error"}`);
  }
  console.log("    refused as documented:", refused.slice(0, 100) + "...");

  // 5b. Account-only session
  console.log("\n[5b] grantSession({ register: false }) (1h, scoped to funder, 1 CELO/day)");
  const session = await client.grantSession({
    wallet,
    signer: passkey,
    register: false,
    permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("1"), period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (s) => console.log(`    status: ${s} [${ms(t0)}]`),
  });
  console.log("    account tx:", session.transactionHash);
  console.log("    registry:  ", show(session.registry));
  console.log("    cache:     ", show(session.cache));
  if (session.registry?.status !== "SKIPPED" || session.cache?.status !== "SKIPPED") {
    throw new Error("expected registry and cache steps to be skipped for register: false");
  }
  console.log(`    granted [${ms(t0)}]`);

  // 6. Execute as the session
  console.log("\n[6] execute(session, sendOneWei) under the passkey admin");
  const sessionExec = await client.execute({ session, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", sessionExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", sessionExec.transactionHash);
  if (sessionExec.status !== "CONFIRMED") throw new Error("session execute failed");

  // 7. Revoke
  console.log("\n[7] revokeSession (passkey admin)");
  const revokeRes = await client.revokeSession({ wallet, signer: passkey, session });
  console.log("    account:", revokeRes.status, revokeRes.transactionHash, `[${ms(t0)}]`);
  console.log("    registry:", show(revokeRes.registry));
  console.log("    cache:   ", show(revokeRes.cache));
  if (revokeRes.status !== "CONFIRMED") throw new Error("account revoke failed");

  console.log("\n==================================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nCelo Sepolia passkey smoke test crashed:", err);
  process.exit(1);
});
