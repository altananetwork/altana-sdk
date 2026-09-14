/**
 * Passkey smoke test on Celo Sepolia (chain 11142220), headless variant so it
 * runs in Node:
 *   1. createHeadlessPasskey() -> PasskeySigner
 *   2. createWallet({ signer: passkey }): throwaway secp256k1 signs the
 *      EIP-7702 setCode, the passkey becomes the admin authority
 *   3. fund the wallet with CELO
 *   4. execute(wallet, passkey, sendOneWei): the P256 signature is verified
 *      by the account through the P256 canary on Celo Sepolia
 *   5. grantSession(wallet, passkey): a registered grant, its Sepolia
 *      registry write relayed (the testnet relay serves Sepolia, so a P256
 *      admin can register); then grantSession({ register: false }): an
 *      account-only session. The account enforces permissions/expiry on both.
 *   6. execute(session, ...): the session-key path under a passkey admin
 *   7. revokeSession(wallet, passkey, session): account revoke; registry and
 *      cache steps are reported as skipped
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY   funded with CELO on Celo Sepolia (>= 1 CELO,
 *                     https://faucet.celo.org/celo-sepolia) and ETH on Sepolia
 *                     (>= 0.01 ETH, for the relayed registry write)
 *   CELO_SEPOLIA_RPC_URL  optional override of the Celo Sepolia read RPC
 *
 * Run: bun run smoke:celo-passkey   (from tests/e2e)
 */

import {
  createClient,
  createHeadlessPasskey,
  CELO_SEPOLIA,
  SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertStatus, legOf, printLegs } from "./session-legs.js";

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
  if (bal < parseEther("1")) {
    throw new Error(`Fund ${funder.address} with at least 1 CELO on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
  }
  const sepoliaPublic = createPublicClient({ chain: SEPOLIA.chain, transport: http(SEPOLIA.publicRpcUrl) });
  const sepoliaFunder = createWalletClient({ account: funder, chain: SEPOLIA.chain, transport: http(SEPOLIA.publicRpcUrl) });
  const sepoliaBal = await sepoliaPublic.getBalance({ address: funder.address });
  if (sepoliaBal < parseEther("0.01")) {
    throw new Error(`Fund ${funder.address} with at least 0.01 ETH on Sepolia: https://cloud.google.com/application/web3/faucet/ethereum/sepolia`);
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
  console.log("\n[3] Fund the wallet with 0.5 CELO on Celo Sepolia and 0.003 ETH on Sepolia");
  const fundTx = await celoFunder.sendTransaction({ to: wallet.address, value: parseEther("0.5") });
  const sepoliaFundTx = await sepoliaFunder.sendTransaction({ to: wallet.address, value: parseEther("0.003") });
  await Promise.all([
    celoPublic.waitForTransactionReceipt({ hash: fundTx }),
    sepoliaPublic.waitForTransactionReceipt({ hash: sepoliaFundTx }),
  ]);
  console.log(`    funded [${ms(t0)}]`);

  // 4. First execute: P256 signature verified on Celo Sepolia (P256 canary)
  console.log("\n[4] execute(wallet, passkey, sendOneWei)");
  const firstExec = await client.execute({ wallet, signer: passkey, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", firstExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", firstExec.transactionHash);
  if (firstExec.status !== "CONFIRMED") throw new Error("First execute failed");

  // 5a. A registered grant: the Sepolia registry write goes through the relay, so a passkey admin can sign it.
  console.log("\n[5a] grantSession with register: true (passkey admin, registry write relayed on Sepolia)");
  const registered = await client.grantSession({
    wallet,
    signer: passkey,
    permissions: { calls: [{ to: funder.address }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  printLegs(registered.legs);
  assertStatus(registered, "granted", "registered grantSession");
  if (legOf(registered.legs, "registry", SEPOLIA.chainId).via !== "relay") {
    throw new Error("expected the Sepolia registry write to go through the relay");
  }

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
  printLegs(session.legs);
  assertStatus(session, "granted", "grantSession");
  if (session.legs.some((l) => l.kind === "registry") || legOf(session.legs, "cache", CELO_SEPOLIA.chainId).status !== "SKIPPED") {
    throw new Error("expected no registry write and a skipped cache step for register: false");
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
  console.log("    status:", revokeRes.status, `[${ms(t0)}]`);
  printLegs(revokeRes.legs);
  assertStatus(revokeRes, "revoked", "revokeSession");
  const revokeRegistered = await client.revokeSession({ wallet, signer: passkey, session: registered });
  printLegs(revokeRegistered.legs);
  assertStatus(revokeRegistered, "revoked", "revokeSession (registered session)");

  console.log("\n==================================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nCelo Sepolia passkey smoke test crashed:", err);
  process.exit(1);
});
