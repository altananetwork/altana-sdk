/**
 * Does a wallet's FIRST bundle fail more often than its second?
 *
 * Two bundles failed on the hosted testnet relay on 2026-10-06 and both passed
 * on an immediate retry. Both were a wallet's first bundle, the one that also
 * registers the admin key and pays the KeyStore registration fee. That is a
 * plausible common factor and nothing more, so this measures it.
 *
 * A first grant is the first thing every user of the wallet app does, so if it
 * fails intermittently it is the product's first impression.
 *
 * Per wallet: create a counterfactual passkey wallet, fund it, attempt a tiny
 * transfer, attempt a second one, then sweep. Every attempt records whether the
 * wallet was already delegated beforehand, which is what actually distinguishes
 * a first bundle from a later one, and the relay's **full** response on failure.
 *
 *   WALLETS=20 bun run diagnose-first-bundle.ts
 *
 * Sequential on purpose: one user does one thing at a time, and a concurrent
 * loop would measure how the relay handles load rather than how it handles a
 * first bundle.
 */

import {
  createClient,
  createHeadlessPasskey,
  BNB_TESTNET,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { appendFile } from "node:fs/promises";
import { createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const COUNT = Number(process.env.WALLETS ?? 20);
const FUND = parseEther("0.012");
const SWEEP_MARGIN = parseEther("0.004");
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;
/** Where credentials go when a wallet cannot be swept, so funds are not stranded. */
const ENV_FILE = "/Users/dor1s/Documents/Altana-Ecosystem-Mainnet/.env.testnet";

const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex | undefined;
if (!FUNDER_KEY) throw new Error("TEST_FUNDER_KEY is not set. Load the shared .env.testnet.");

const NETWORK: NetworkConfig = { ...BNB_TESTNET };
const client = createClient({ chains: [NETWORK] });
const publicClient = buildPublicClient(NETWORK);
const funder = privateKeyToAccount(FUNDER_KEY);
const funderClient = createWalletClient({
  account: funder,
  chain: bscTestnet,
  transport: http(NETWORK.publicRpcUrl),
});

type Attempt = {
  n: 1 | 2;
  /** The thing that actually distinguishes a first bundle from a later one. */
  delegatedBefore: boolean;
  landed: boolean;
  txHash?: string;
  /** The relay's full response or error, untruncated. */
  detail: string;
};

type Run = { wallet: string; credential: string; attempts: Attempt[]; sweptBack: string };

const runs: Run[] = [];
/** Wallets whose funding never confirmed, so they were never measured. */
const skipped: { wallet: string; fundTx: string }[] = [];

/** Everything an error carries, including what it wraps. */
function describe(err: unknown): string {
  const parts: string[] = [];
  let node: unknown = err;
  for (let i = 0; i < 6 && node && typeof node === "object"; i++) {
    const e = node as { name?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.name === "string" || typeof e.message === "string") {
      parts.push(`${String(e.name ?? "Error")}: ${String(e.message ?? "")}`);
    }
    if (e.cause === node) break;
    node = e.cause;
  }
  return parts.join(" || ") || String(err);
}

async function attempt(
  n: 1 | 2,
  wallet: { address: `0x${string}` },
  signer: ReturnType<typeof createHeadlessPasskey>,
): Promise<Attempt> {
  const code = await publicClient.getCode({ address: wallet.address }).catch(() => undefined);
  const delegatedBefore = Boolean(code && code !== "0x");
  try {
    const result = await client.execute({
      wallet,
      signer,
      calls: { to: RECIPIENT, value: 1n, data: "0x" },
    });
    const landed = String(result.status).toUpperCase() === "CONFIRMED";
    return {
      n,
      delegatedBefore,
      landed,
      ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
      // The whole object when it did not land, so nothing is lost to a status field.
      detail: landed
        ? String(result.status)
        : JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    };
  } catch (err) {
    return { n, delegatedBefore, landed: false, detail: describe(err) };
  }
}

console.log(`First-bundle reliability: ${COUNT} fresh wallets, two attempts each`);
console.log(`  relay   ${NETWORK.relayUrl}`);
console.log(`  funder  ${formatEther(await publicClient.getBalance({ address: funder.address }))} tBNB\n`);

for (let i = 1; i <= COUNT; i++) {
  const passkey = createHeadlessPasskey();
  const wallet = await client.createWallet({ signer: passkey });
  const credential = JSON.stringify(passkey.credential);

  // Written to disk BEFORE any money moves. A crash between funding and the
  // sweep would otherwise strand the funds with no way to reach them, which is
  // exactly what happened on the first attempt at this run: the script died
  // waiting for a receipt and took the only copy of the credential with it.
  await appendFile(
    ENV_FILE,
    `\n# first-bundle run ${new Date().toISOString()}, wallet ${i}/${COUNT}, funded ${formatEther(FUND)} tBNB\n` +
      `FIRSTBUNDLE_${wallet.address.slice(2, 10).toUpperCase()}_CREDENTIAL='${credential}'\n`,
  );

  const fundTx = await funderClient.sendTransaction({ to: wallet.address, value: FUND });
  // Generous, and survivable. The public RPC has held a funder transaction in
  // its mempool without propagating it, so a short timeout turns a slow
  // confirmation into a dead run.
  try {
    await publicClient.waitForTransactionReceipt({ hash: fundTx, timeout: 180_000 });
  } catch {
    console.log(`${String(i).padStart(2)}/${COUNT} ${wallet.address}  funding never confirmed (${fundTx}), skipping`);
    skipped.push({ wallet: wallet.address, fundTx });
    continue;
  }

  const a1 = await attempt(1, wallet, passkey);
  const a2 = await attempt(2, wallet, passkey);

  // Sweep, so nothing is stranded. Not retried: this is a reliability
  // measurement and a retry here would muddy the per-wallet picture.
  let sweptBack = "0";
  const left = await publicClient.getBalance({ address: wallet.address });
  if (left > SWEEP_MARGIN) {
    try {
      const s = await client.execute({
        wallet,
        signer: passkey,
        calls: { to: funder.address, value: left - SWEEP_MARGIN, data: "0x" },
      });
      if (String(s.status).toUpperCase() === "CONFIRMED") sweptBack = formatEther(left - SWEEP_MARGIN);
    } catch {
      /* recorded as 0 swept; the credential is saved below */
    }
  }

  runs.push({ wallet: wallet.address, credential, attempts: [a1, a2], sweptBack });

  const mark = (a: Attempt) => (a.landed ? "ok  " : "FAIL");
  console.log(
    `${String(i).padStart(2)}/${COUNT} ${wallet.address}  ` +
      `a1 ${mark(a1)}${a1.delegatedBefore ? "(delegated)" : "(first)   "}  ` +
      `a2 ${mark(a2)}${a2.delegatedBefore ? "(delegated)" : "(first)   "}  ` +
      `swept ${sweptBack}`,
  );
  if (!a1.landed) console.log(`        a1: ${a1.detail}`);
  if (!a2.landed) console.log(`        a2: ${a2.detail}`);
}

// ── Results ────────────────────────────────────────────────────────────────

const all = runs.flatMap((r) => r.attempts);
// "First bundle" means the wallet had no delegation code yet, which is the real
// distinction. A failed attempt 1 leaves attempt 2 a first bundle too.
const firstBundles = all.filter((a) => !a.delegatedBefore);
const laterBundles = all.filter((a) => a.delegatedBefore);
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

const firstFailed = firstBundles.filter((a) => !a.landed);
const laterFailed = laterBundles.filter((a) => !a.landed);

console.log("\n==========================================================");
console.log("RESULT");
console.log("==========================================================");
console.log(`  first bundles (no delegation yet):  ${firstBundles.length} attempts, ${firstFailed.length} failed  ${pct(firstFailed.length, firstBundles.length)}`);
console.log(`  later bundles (already delegated):  ${laterBundles.length} attempts, ${laterFailed.length} failed  ${pct(laterFailed.length, laterBundles.length)}`);
console.log(`  wallets where attempt 1 failed and attempt 2 landed: ${runs.filter((r) => !r.attempts[0]!.landed && r.attempts[1]!.landed).length}`);
console.log(`  wallets where both attempts failed:                  ${runs.filter((r) => r.attempts.every((a) => !a.landed)).length}`);

if (firstFailed.length > 0) {
  console.log("\n  Every first-bundle failure, in full:");
  for (const r of runs) {
    for (const a of r.attempts) {
      if (!a.landed && !a.delegatedBefore) console.log(`   ${r.wallet} a${a.n}\n     ${a.detail}`);
    }
  }
}
if (laterFailed.length > 0) {
  console.log("\n  Every later-bundle failure, in full:");
  for (const r of runs) {
    for (const a of r.attempts) {
      if (!a.landed && a.delegatedBefore) console.log(`   ${r.wallet} a${a.n}\n     ${a.detail}`);
    }
  }
}

if (skipped.length > 0) {
  console.log(`\n  ${skipped.length} wallets skipped because their funding never confirmed:`);
  for (const s of skipped) console.log(`   ${s.wallet}  ${s.fundTx}`);
  console.log("  Their credentials are in .env.testnet, so nothing is stranded.");
}

const unswept = runs.filter((r) => r.sweptBack === "0");
if (unswept.length > 0) {
  console.log(`\n  ${unswept.length} wallets kept a balance; their credentials are already in .env.testnet.`);
}

console.log(`\n  funder now ${formatEther(await publicClient.getBalance({ address: funder.address }))} tBNB`);
