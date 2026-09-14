/**
 * Grant and revoke on every chain, live: Celo Sepolia and Base Sepolia, both
 * cached networks behind the Sepolia KeyStore.
 *
 *   1. createWallet on both chains (same address)
 *   2. fund the wallet: CELO on Celo Sepolia, ETH on Base Sepolia and ETH on
 *      Sepolia (relay fees on each chain, plus the Sepolia registration fee)
 *   3. quoteGrantSession, then grantSession on both chains: one registry
 *      write on Sepolia, one account leg and one cache proof per chain
 *   4. reads: both accounts hold the key, Sepolia lists it as valid
 *   5. quoteRevokeSession, then revokeSession through the client: discovery
 *      finds both chains, one account leg per chain, one registry leg on
 *      Sepolia, one cache proof per chain; final status `revoked`
 *   6. reads: neither account holds the key, Sepolia reports it revoked
 *   7. the signature count of each flow (one per leg that sent something)
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY  funded with CELO on Celo Sepolia (>= 1 CELO,
 *                    https://faucet.celo.org/celo-sepolia), ETH on Base
 *                    Sepolia (>= 0.01 ETH) and ETH on Sepolia (>= 0.01 ETH)
 *   SEPOLIA_RPC_URL  optional override (must serve eth_getProof ~100 blocks behind head)
 *
 * Run: bun run smoke:everywhere   (from tests/e2e)
 */

import {
  accountHasKey,
  createClient,
  createPrivateKeySigner,
  formatQuoteLine,
  keyHashForSessionOrKey,
  BASE_SEPOLIA,
  CELO_SEPOLIA,
  SEPOLIA,
  networkByChainId,
  type NetworkConfig,
  type SessionQuote,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertStatus, legOf, printLegs, signatureCount } from "./session-legs.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia, ETH on Base Sepolia and ETH on Sepolia.",
  );
}

const sepolia: NetworkConfig = { ...SEPOLIA, publicRpcUrl: process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl };
const withL1 = (n: NetworkConfig): NetworkConfig =>
  n.registry?.kind === "cached" ? { ...n, registry: { ...n.registry, l1: sepolia } } : n;
const celoSepolia = withL1(CELO_SEPOLIA);
const baseSepolia = withL1(BASE_SEPOLIA);
const CHAINS = [celoSepolia, baseSepolia];

const KEYSTORE_ABI = [
  { name: "isValidKey", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

const t0 = performance.now();
const ms = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
const status = (s: string, d?: { chainId: number }) => console.log(`    status: ${s}${d ? ` (chain ${d.chainId})` : ""} [${ms()}]`);

function printQuote(q: SessionQuote) {
  for (const line of q.lines) console.log(`    ${formatQuoteLine(line, networkByChainId(line.chainId)!)}`);
  for (const b of q.balances) {
    console.log(`    balance chain ${b.chainId} ${b.address}: ${formatEther(b.balance)} ${b.symbol}, takes ${formatEther(b.outflow)} ${b.symbol}${b.sufficient ? "" : "  INSUFFICIENT"}`);
  }
  if (!q.complete) console.log("    (incomplete: some legs could not be quoted ahead of time)");
}

async function main() {
  console.log("@altananetwork/sdk: grant and revoke everywhere (Celo Sepolia + Base Sepolia, registry on Sepolia)");
  console.log("==================================================================================================\n");

  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const publicOf = (n: NetworkConfig): PublicClient => createPublicClient({ chain: n.chain, transport: http(n.publicRpcUrl) });
  const funding: [NetworkConfig, bigint, bigint][] = [
    [celoSepolia, parseEther("1"), parseEther("0.5")],
    [baseSepolia, parseEther("0.01"), parseEther("0.003")],
    [sepolia, parseEther("0.01"), parseEther("0.004")],
  ];
  for (const [n, min] of funding) {
    const bal = await publicOf(n).getBalance({ address: funder.address });
    console.log(`funder on ${n.chain.name}: ${formatEther(bal)} ${n.chain.nativeCurrency.symbol}`);
    if (bal < min) throw new Error(`Fund ${funder.address} with at least ${formatEther(min)} ${n.chain.nativeCurrency.symbol} on ${n.chain.name}`);
  }

  console.log("\n[1] createWallet on both chains");
  const client = createClient({ chains: CHAINS });
  const admin = createPrivateKeySigner();
  const wallet = await client.createWallet({ signer: admin });
  console.log(`    wallet ${wallet.address} [${ms()}]`);

  console.log("\n[2] fund the wallet on Celo Sepolia, Base Sepolia and Sepolia");
  await Promise.all(
    funding.map(async ([n, , amount]) => {
      const hash = await createWalletClient({ account: funder, chain: n.chain, transport: http(n.publicRpcUrl) }).sendTransaction({ to: wallet.address, value: amount });
      await publicOf(n).waitForTransactionReceipt({ hash });
    }),
  );
  console.log(`    funded [${ms()}]`);

  const permissions = { calls: [{ to: funder.address }], spend: [{ limit: parseEther("0.001"), period: "day" as const }] };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const sessionSigner = createPrivateKeySigner();

  console.log("\n[3a] quoteGrantSession");
  printQuote(await client.quoteGrantSession({ wallet, signer: admin, sessionSigner, permissions, expiry }));

  console.log("\n[3b] grantSession on both chains");
  const session = await client.grantSession({ wallet, signer: admin, sessionSigner, permissions, expiry, onStatus: status });
  printLegs(session.legs);
  assertStatus(session, "granted", "grantSession");
  if (session.legs.filter((l) => l.kind === "registry").length !== 1) throw new Error("expected exactly one registry leg");
  console.log(`    granted, ${signatureCount(session.legs)} signatures [${ms()}]`);

  console.log("\n[4] reads after grant");
  const keyHash = keyHashForSessionOrKey(session);
  const keyId = keccak256(session.publicKey);
  for (const n of CHAINS) {
    const held = await accountHasKey(publicOf(n), wallet.address, keyHash);
    console.log(`    ${n.chain.name} account holds the key: ${held}`);
    if (!held) throw new Error(`${n.chain.name} account does not hold the granted key`);
  }
  const validAfterGrant = await publicOf(sepolia).readContract({ address: sepolia.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [wallet.address, keyId] });
  console.log(`    Sepolia KeyStore.isValidKey: ${validAfterGrant}`);
  if (!validAfterGrant) throw new Error("Sepolia does not list the granted key");

  console.log("\n[5a] quoteRevokeSession");
  printQuote(await client.quoteRevokeSession({ wallet, signer: admin, session }));

  console.log("\n[5b] revokeSession (client on Celo Sepolia + Base Sepolia; discovery decides the legs)");
  const revoked = await client.revokeSession({ wallet, signer: admin, session, onStatus: status });
  printLegs(revoked.legs);
  assertStatus(revoked, "revoked", "revokeSession");
  const discovered = revoked.legs.filter((l) => l.kind === "account").map((l) => l.chainId);
  console.log(`    discovered on chains: ${discovered.join(", ")}`);
  for (const n of CHAINS) {
    legOf(revoked.legs, "account", n.chainId);
    legOf(revoked.legs, "cache", n.chainId);
  }
  if (revoked.legs.filter((l) => l.kind === "registry").length !== 1) throw new Error("expected exactly one registry leg");
  if (legOf(revoked.legs, "registry", sepolia.chainId).status !== "CONFIRMED") throw new Error("Sepolia registry revoke did not confirm");
  console.log(`    final status: ${revoked.status}, ${signatureCount(revoked.legs)} signatures [${ms()}]`);

  console.log("\n[6] reads after revoke");
  for (const n of CHAINS) {
    const held = await accountHasKey(publicOf(n), wallet.address, keyHash);
    console.log(`    ${n.chain.name} account holds the key: ${held}`);
    if (held) throw new Error(`${n.chain.name} account still holds the revoked key`);
  }
  const validAfterRevoke = await publicOf(sepolia).readContract({ address: sepolia.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [wallet.address, keyId] });
  console.log(`    Sepolia KeyStore.isValidKey: ${validAfterRevoke}`);
  if (validAfterRevoke) throw new Error("Sepolia still lists the revoked key as valid");

  console.log("\n[7] signatures");
  console.log(`    grant:  ${signatureCount(session.legs)} (one per leg that sent something)`);
  console.log(`    revoke: ${signatureCount(revoked.legs)}`);

  console.log("\n==================================================================================================");
  console.log(`Total wall-clock: ${ms()}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nEverywhere smoke test crashed:", err);
  process.exit(1);
});
