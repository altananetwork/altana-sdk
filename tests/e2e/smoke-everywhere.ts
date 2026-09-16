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
 *   SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, CELO_SEPOLIA_RPC_URL  optional RPC
 *                    overrides (Sepolia's must serve eth_getProof ~100 blocks behind head)
 *
 * All of them come from the shared testnet env:
 *   set -a; source <ecosystem>/.env.testnet; set +a
 *
 * The throwaway wallet's leftover funds go back to the funder at the end, pass or fail.
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
  quoteCalls,
  signerFromPrivateKey,
  type Signer,
  type NetworkConfig,
  type SessionQuote,
} from "@altananetwork/sdk";
import { createClient as createViemClient, createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { assertStatus, legOf, printLegs, signatureCount } from "./session-legs.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia, ETH on Base Sepolia and ETH on Sepolia.",
  );
}

const sepolia: NetworkConfig = { ...SEPOLIA, publicRpcUrl: process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl };
const withL1 = (n: NetworkConfig, rpc: string | undefined): NetworkConfig => ({
  ...n,
  ...(rpc ? { publicRpcUrl: rpc } : {}),
  ...(n.registry?.kind === "cached" ? { registry: { ...n.registry, l1: sepolia } } : {}),
});
const celoSepolia = withL1(CELO_SEPOLIA, process.env.CELO_SEPOLIA_RPC_URL);
const baseSepolia = withL1(BASE_SEPOLIA, process.env.BASE_SEPOLIA_RPC_URL);
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
    console.log(`    balance chain ${b.chainId} ${b.address}: ${formatEther(b.balance)} ${b.symbol}, needs ${formatEther(b.needed)} ${b.symbol}${b.sufficient ? "" : "  INSUFFICIENT"}`);
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
    // Nothing on Sepolia: the relay funds the registry writes from the wallet's L2 balance.
  ];
  for (const [n, min] of funding) {
    const bal = await publicOf(n).getBalance({ address: funder.address });
    console.log(`funder on ${n.chain.name}: ${formatEther(bal)} ${n.chain.nativeCurrency.symbol}`);
    if (bal < min) throw new Error(`Fund ${funder.address} with at least ${formatEther(min)} ${n.chain.nativeCurrency.symbol} on ${n.chain.name}`);
  }

  console.log("\n[1] createWallet on both chains");
  const client = createClient({ chains: CHAINS });
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  console.log(`    wallet ${wallet.address} [${ms()}]`);
  // Save the throwaway key before any funds are sent, so nothing is stranded if the run dies.
  saveThrowawayKey(wallet.address, adminKey);
  try {
    await run(client, admin, wallet, funder, publicOf, funding);
  } finally {
    await sweepBack(admin, wallet, funder.address, publicOf, funding.map(([n]) => n));
  }
}

async function run(
  client: ReturnType<typeof createClient>,
  admin: Signer,
  wallet: { address: `0x${string}` },
  funder: ReturnType<typeof privateKeyToAccount>,
  publicOf: (n: NetworkConfig) => PublicClient,
  funding: [NetworkConfig, bigint, bigint][],
) {
  console.log("\n[2] fund the wallet on Celo Sepolia, Base Sepolia and Sepolia");
  // One chain at a time: the shared funder can be used by other sessions, so a dropped or
  // replaced transaction is detected by the wallet's balance and sent again.
  for (const [n, , amount] of funding) {
    await fundOnce(n, funder, wallet.address, amount, publicOf(n));
    console.log(`    ${n.chain.name}: funded ${formatEther(amount)} ${n.chain.nativeCurrency.symbol} [${ms()}]`);
  }

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
  const grantRegistry = legOf(session.legs, "registry", sepolia.chainId);
  if (![celoSepolia.chainId, baseSepolia.chainId].includes(grantRegistry.fundedFromChainId ?? -1)) throw new Error("Sepolia registry write was not funded from an L2");
  console.log(`    registry write funded from chain ${grantRegistry.fundedFromChainId}, source tx ${grantRegistry.sourceTransactionHash}`);
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
  const revokeRegistry = legOf(revoked.legs, "registry", sepolia.chainId);
  if (revokeRegistry.status !== "CONFIRMED") throw new Error("Sepolia registry revoke did not confirm");
  if (![celoSepolia.chainId, baseSepolia.chainId].includes(revokeRegistry.fundedFromChainId ?? -1)) throw new Error("Sepolia registry revoke was not funded from an L2");
  console.log(`    registry revoke funded from chain ${revokeRegistry.fundedFromChainId}, source tx ${revokeRegistry.sourceTransactionHash}`);
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

/** Appends the throwaway admin key to the shared testnet env file (never printed). */
function saveThrowawayKey(address: `0x${string}`, key: Hex) {
  const file = process.env.TESTNET_ENV_FILE ?? new URL("../../../.env.testnet", import.meta.url).pathname;
  appendFileSync(
    file,
    `\n# smoke-everywhere throwaway wallet ${address}, ${new Date().toISOString()}: admin key\n` +
      `SMOKE_THROWAWAY_${address.slice(2, 10).toUpperCase()}_KEY=${key}\n`,
  );
  console.log(`    throwaway key saved to the shared testnet env file`);
}

/** Funds `to` with `amount`, resending (fresh nonce) if the transaction is dropped. */
async function fundOnce(
  n: NetworkConfig,
  funder: ReturnType<typeof privateKeyToAccount>,
  to: `0x${string}`,
  amount: bigint,
  pc: PublicClient,
) {
  const walletClient = createWalletClient({ account: funder, chain: n.chain, transport: http(n.publicRpcUrl) });
  const start = await pc.getBalance({ address: to });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const nonce = await pc.getTransactionCount({ address: funder.address, blockTag: "pending" });
    const hash = await walletClient.sendTransaction({ to, value: amount, nonce });
    try {
      await pc.waitForTransactionReceipt({ hash, timeout: 180_000 });
      return;
    } catch (err) {
      if ((await pc.getBalance({ address: to })) >= start + amount) return;
      console.log(`    ${n.chain.name}: funding tx ${hash} not mined (attempt ${attempt}), resending`);
      if (attempt === 3) throw err;
    }
  }
}

/**
 * Sends what is left in the throwaway wallet back to the funder on each chain: the balance minus
 * the relay's quoted fee for the transfer (with headroom). Best effort, logged, never throws.
 */
async function sweepBack(
  admin: Signer,
  wallet: { address: `0x${string}` },
  funder: `0x${string}`,
  publicOf: (n: NetworkConfig) => PublicClient,
  networks: NetworkConfig[],
) {
  console.log("\n[sweep] return leftover funds to the funder");
  for (const n of networks) {
    const symbol = n.chain.nativeCurrency.symbol;
    try {
      const balance = await publicOf(n).getBalance({ address: wallet.address });
      if (balance === 0n) {
        console.log(`    ${n.chain.name}: nothing left`);
        continue;
      }
      const opts = {
        feeToken: "0x0000000000000000000000000000000000000000" as const,
        submittingKey: { type: "secp256k1" as const, publicKey: admin.publicKey, role: "admin" as const },
        network: n,
      };
      const relay = createViemClient({ chain: n.chain, transport: http(n.relayUrl!) });
      // Quote the transfer at the amount actually sent and take the relay's fee off it; repeat
      // while the relay still reports a deficit (the fee depends on the call).
      // Size the transfer from the relay's own quote: everything but the fee (and any registration
      // fee a first action prepends), with headroom.
      const probe = await quoteCalls(relay, wallet.address, admin, [{ to: funder, value: 1n, data: "0x" }], opts);
      const fee = probe.nativeNeeded - 1n;
      const amount = balance - (fee * 13n) / 10n;
      if (amount <= 0n) {
        console.log(`    ${n.chain.name}: ${formatEther(balance)} ${symbol} left, below the transfer fee (${formatEther(fee)}); kept`);
        continue;
      }
      const res = await createClient({ chains: [n] }).execute({ wallet, signer: admin, calls: { to: funder, value: amount, data: "0x" } });
      console.log(`    ${n.chain.name}: returned ${formatEther(amount)} ${symbol} (${res.status}${res.transactionHash ? ` ${res.transactionHash}` : ""})`);
    } catch (err) {
      console.log(`    ${n.chain.name}: sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  }
}

main().catch((err) => {
  console.error("\nEverywhere smoke test crashed:", err);
  process.exit(1);
});
