/**
 * Session-key smoke test on Celo Sepolia (chain 11142220), the cached-registry
 * testnet: wallets execute through the Altana testnet relay on Celo Sepolia,
 * the KeyStore registry lives on Sepolia, and session keys are proven into
 * the Celo Sepolia KeyStoreCache.
 *
 *   1. createWallet (admin signer)
 *   2. fund the wallet on Celo Sepolia (CELO, relay fees) and on Sepolia
 *      (ETH: registry writes are direct transactions from the admin key,
 *      which is the wallet address itself)
 *   3. execute(wallet, admin, ...) on Celo Sepolia (no registry prepend here)
 *   4. grantSession: registry write on Sepolia, account authorization on
 *      Celo Sepolia, proof into the cache; all three reported
 *   5. execute(session, ...) as the agent
 *   6. registry + cache reads: Sepolia isValidKey true, cache getCachedKey set
 *   7. revokeSession: account revoke, registry revoke, post-revocation proof
 *   8. execute(session, ...) after revoke: rejected
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY   funded with CELO on Celo Sepolia (>= 0.2 CELO,
 *                     https://faucet.celo.org/celo-sepolia) AND with ETH on
 *                     Sepolia (>= 0.01 ETH, https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
 *   CELO_SEPOLIA_CACHE  optional override of the KeyStoreCacheOPStack address
 *                     (the SDK config carries the deployed one)
 *   SEPOLIA_RPC_URL   optional override of the Sepolia RPC (default
 *                     SEPOLIA.publicRpcUrl; it must serve eth_getProof for
 *                     the block Celo Sepolia anchors, about 100 behind head)
 *   CELO_SEPOLIA_RPC_URL  optional override of the Celo Sepolia read RPC
 *
 * Run: bun run smoke:celo-sepolia   (from tests/e2e)
 */

import {
  createClient,
  createPrivateKeySigner,
  isCachedKeyValid,
  readCachedKey,
  CELO_SEPOLIA,
  keyStoreCacheOf,
  SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia (https://faucet.celo.org/celo-sepolia) " +
      "and with ETH on Sepolia (https://cloud.google.com/application/web3/faucet/ethereum/sepolia).",
  );
}

const CACHE = ((process.env.CELO_SEPOLIA_CACHE as Address | undefined) ?? keyStoreCacheOf(CELO_SEPOLIA)) as Address;

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl;
const sepolia: NetworkConfig = { ...SEPOLIA, publicRpcUrl: SEPOLIA_RPC };
const celoSepolia: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  registry: { kind: "cached", l1: sepolia, keyStoreCache: CACHE },
};

const KEYSTORE_ABI = [
  { name: "isValidKey", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}
function show(v: unknown) {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
}

async function main() {
  console.log("@altananetwork/sdk session smoke test: Celo Sepolia (registry on Sepolia)");
  console.log("=========================================================================\n");

  const t0 = performance.now();
  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const celoPublic: PublicClient = createPublicClient({ chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const sepoliaPublic: PublicClient = createPublicClient({ chain: sepolia.chain, transport: http(sepolia.publicRpcUrl) });
  const celoFunder = createWalletClient({ account: funder, chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const sepoliaFunder = createWalletClient({ account: funder, chain: sepolia.chain, transport: http(sepolia.publicRpcUrl) });

  const [celoBal, sepoliaBal] = await Promise.all([
    celoPublic.getBalance({ address: funder.address }),
    sepoliaPublic.getBalance({ address: funder.address }),
  ]);
  console.log(`funder ${funder.address}: ${formatEther(celoBal)} CELO on Celo Sepolia, ${formatEther(sepoliaBal)} ETH on Sepolia`);
  if (celoBal < parseEther("1")) {
    throw new Error(`Fund ${funder.address} with at least 0.2 CELO on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
  }
  if (sepoliaBal < parseEther("0.01")) {
    throw new Error(`Fund ${funder.address} with at least 0.01 ETH on Sepolia: https://cloud.google.com/application/web3/faucet/ethereum/sepolia`);
  }
  console.log(`cache: ${CACHE}\n`);

  // 1. Create wallet with admin signer
  console.log("[1] createWallet + admin signer");
  const client = createClient({ chains: [celoSepolia] });
  const adminSigner = createPrivateKeySigner();
  const wallet = await client.createWallet({ signer: adminSigner });
  console.log("    wallet.address:    ", wallet.address);
  console.log(`    done [${ms(t0)}]`);

  // 2. Fund on both chains
  console.log("\n[2] Fund the wallet: 0.5 CELO on Celo Sepolia, 0.003 ETH on Sepolia (registry writes)");
  const celoFund = await celoFunder.sendTransaction({ to: wallet.address, value: parseEther("0.5") });
  const sepoliaFund = await sepoliaFunder.sendTransaction({ to: wallet.address, value: parseEther("0.003") });
  await Promise.all([
    celoPublic.waitForTransactionReceipt({ hash: celoFund }),
    sepoliaPublic.waitForTransactionReceipt({ hash: sepoliaFund }),
  ]);
  console.log(`    funded [${ms(t0)}]`);

  // 3. First execute on Celo Sepolia: gasless through the relay, fee in CELO,
  //    no registry prepend (the registry is on Sepolia).
  console.log("\n[3] execute(wallet, admin, sendOneWei) on Celo Sepolia");
  const firstExec = await client.execute({ wallet, signer: adminSigner, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", firstExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", firstExec.transactionHash);
  if (firstExec.status !== "CONFIRMED") throw new Error("First execute failed");

  // 4. Grant a session: three steps, all reported.
  console.log("\n[4] grantSession (1h expiry, scoped to funder + 1 CELO/day cap)");
  const session = await client.grantSession({
    wallet,
    signer: adminSigner,
    permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("1"), period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (s) => console.log(`    status: ${s} [${ms(t0)}]`),
  });
  console.log("    account tx (Celo Sepolia):", session.transactionHash);
  console.log("    registry (Sepolia):       ", show(session.registry));
  console.log("    cache (Celo Sepolia):     ", show(session.cache));
  if (session.registry?.status !== "CONFIRMED") throw new Error("registry write did not confirm");
  if (session.cache?.status !== "CONFIRMED") throw new Error(`cache proof did not confirm: ${session.cache?.reason}`);
  console.log(`    granted [${ms(t0)}]`);

  // 5. Execute as the session
  console.log("\n[5] execute(session, sendOneWei) on Celo Sepolia");
  const sessionExec = await client.execute({ session, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", sessionExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", sessionExec.transactionHash);
  if (sessionExec.status !== "CONFIRMED") throw new Error("session execute failed");

  // 6. Reads: registry on Sepolia, cache on Celo Sepolia
  console.log("\n[6] reads");
  const keyId = keccak256(session.publicKey);
  const registryValid = await sepoliaPublic.readContract({ address: sepolia.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [wallet.address, keyId] });
  const cached = await readCachedKey(celoPublic, CACHE, wallet.address, keyId);
  const fresh = await isCachedKeyValid(celoPublic, CACHE, wallet.address, keyId);
  console.log("    Sepolia KeyStore.isValidKey:", registryValid);
  console.log("    cache.getCachedKey:", show(cached));
  console.log("    cache.isValidKey (fresh only while the anchor matches):", fresh);
  if (!registryValid) throw new Error("session key not valid on the Sepolia registry");
  if (cached.publicKey.toLowerCase() !== session.publicKey.toLowerCase() || cached.revoked) throw new Error("cache does not hold the live session key");

  // 7. Revoke: account first, then registry, then the post-revocation proof
  console.log("\n[7] revokeSession");
  const revokeRes = await client.revokeSession({ wallet, signer: adminSigner, session });
  console.log("    account (Celo Sepolia):", revokeRes.status, revokeRes.transactionHash, `[${ms(t0)}]`);
  console.log("    registry (Sepolia):    ", show(revokeRes.registry));
  console.log("    cache (Celo Sepolia):  ", show(revokeRes.cache));
  if (revokeRes.status !== "CONFIRMED") throw new Error("account revoke failed");
  if (revokeRes.registry?.status !== "CONFIRMED") throw new Error("registry revoke did not confirm");
  if (revokeRes.cache?.status !== "CONFIRMED") throw new Error(`post-revocation proof did not confirm: ${revokeRes.cache?.reason}`);
  // Public RPCs can lag the relay's confirmation; poll until the entry shows the
  // post-revocation proof (up to 60s).
  let afterCache = await readCachedKey(celoPublic, CACHE, wallet.address, keyId);
  for (let i = 0; i < 20 && !afterCache.revoked; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    afterCache = await readCachedKey(celoPublic, CACHE, wallet.address, keyId);
  }
  console.log("    cache.getCachedKey after revoke: revoked =", afterCache.revoked);
  if (!afterCache.revoked) throw new Error("cache still reports the key as live after the post-revocation proof");

  // 8. Session after revoke: rejected
  console.log("\n[8] execute(session, ...) after revoke, expecting rejection");
  try {
    const afterRevoke = await client.execute({ session, calls: { to: funder.address, value: 1n, data: "0x" } });
    if (afterRevoke.status === "CONFIRMED") throw new Error("UNEXPECTED: session still works after revoke");
    console.log("    rejected as expected, status:", afterRevoke.status);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("UNEXPECTED")) throw err;
    console.log("    rejected as expected:", err instanceof Error ? err.message.slice(0, 120) : err);
  }

  console.log("\n=========================================================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nCelo Sepolia session smoke test crashed:", err);
  process.exit(1);
});
