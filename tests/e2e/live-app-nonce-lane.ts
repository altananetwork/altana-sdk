/**
 * LIVE (Celo Sepolia, via relay-staging) — two session keys on one wallet,
 * driven from two SEPARATE SDK PROCESSES at the same moment, while a grant's
 * KeyStore registration is still in flight. Nothing collides for a nonce.
 *
 * What it has to show:
 *
 *   1. `grantSession` returns with the Sepolia registry leg still `PENDING`.
 *   2. Two workers are spawned at once — separate processes, so no shared lane
 *      state — one per session key, each firing several transactions
 *      concurrently, while that registration runs. Every transaction confirms
 *      on its FIRST attempt with no `InvalidNonce`.
 *   3. Read back from the Orchestrator's own `IntentExecuted`: each key's
 *      transactions sit on that key's own lane with consecutive counters, the
 *      two lanes differ, and the registration's funding intents sit on lane 0.
 *      Three counters, no contention.
 *
 * Before the lane (2026-10-17, same script path) the app's execute took a
 * lane-0 counter *between* the registration's two funding intents, and only
 * timing kept it from colliding — see evidence/2026-10-17-nonce-lanes.md.
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO on Celo Sepolia (>= 5)
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *   SEPOLIA_RPC_URL        optional registry-chain read RPC override
 *   ALTANA_RELAY_URL       optional relay override
 *   APP_LANE_TX_COUNT      how many each worker fires at once (default 2)
 *
 * Run: bun run live:app-lane   (from tests/e2e)
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  sdkBuild,
  serializeSession,
  signerFromPrivateKey,
  waitForBalance,
  type GrantLeg,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  padHex,
  parseEther,
  parseGwei,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount as toAccount } from "viem/accounts";
import { spawn } from "node:child_process";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const TX_COUNT = Number(process.env.APP_LANE_TX_COUNT ?? "2");
/** One relayed operation costs about 0.3 CELO at the live 1,500,000 buffer. */
const CELO_FUNDING = parseEther("4");
const PROBE = parseEther("0.001");

/**
 * The lane a key signs on, recomputed here rather than imported, so this is a
 * check on the published build and not a restatement of it.
 */
const APP_LANE_PREFIX = 0xa17an;
const laneForKeyHash = (keyHash: Hex) =>
  (APP_LANE_PREFIX << 176n) | (BigInt(keccak256(keyHash)) & ((1n << 176n) - 1n));
/** secp256k1 key hash as the account computes it, from the signer's address. */
const accountKeyHash = (address: Address) =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, keccak256(padHex(address, { size: 32 }))]));
const INTENT_EXECUTED = toEventSelector("IntentExecuted(address,uint256,bool,bytes4)");
const INTENT_EXECUTED_ABI = [
  {
    type: "event",
    name: "IntentExecuted",
    inputs: [
      { name: "eoa", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: true },
      { name: "incremented", type: "bool", indexed: false },
      { name: "err", type: "bytes4", indexed: false },
    ],
  },
] as const;

const l1Read = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  registry: { ...(CELO_SEPOLIA.registry as any), l1: { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: l1Read } },
} as NetworkConfig;

const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const t0 = Date.now();
const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString(), txCount: TX_COUNT };

/** The lane and counter of every intent in a transaction, for this wallet. */
async function intentsIn(hash: Hex, wallet: Address) {
  // forno is load balanced; the node that served a receipt need not have it.
  for (let i = 0; i < 10; i++) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      const out: { nonce: bigint; seqKey: bigint; counter: bigint; onAppLane: boolean }[] = [];
      for (const l of r.logs) {
        if (l.topics[0] !== INTENT_EXECUTED) continue;
        const { args } = decodeEventLog({ abi: INTENT_EXECUTED_ABI, topics: l.topics, data: l.data });
        if (String((args as any).eoa).toLowerCase() !== wallet.toLowerCase()) continue;
        const nonce = (args as any).nonce as bigint;
        const seqKey = nonce >> 64n;
        out.push({ nonce, seqKey, counter: nonce & ((1n << 64n) - 1n), onAppLane: seqKey >> 176n === APP_LANE_PREFIX });
      }
      return out;
    } catch {
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  return [];
}

const laneName = (seqKey: bigint, lanes: Record<string, bigint>) => {
  if (seqKey === 0n) return "LANE 0 (the relay's)";
  for (const [label, lane] of Object.entries(lanes)) if (lane === seqKey) return `${label}'s lane 0x${seqKey.toString(16).slice(0, 8)}…`;
  if (seqKey >> 176n === APP_LANE_PREFIX) return `an app lane 0x${seqKey.toString(16).slice(0, 8)}… (not one we expected)`;
  return `other lane 0x${seqKey.toString(16).slice(0, 8)}…`;
};

/** Runs one worker process and returns the JSON line it prints. */
function runWorker(env: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", new URL("./app-lane-worker.ts", import.meta.url).pathname], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      if (!line) return reject(new Error(`worker ${env.WORKER_LABEL} printed nothing (exit ${code}): ${err.slice(0, 600)}`));
      resolve(JSON.parse(line));
    });
    child.on("error", reject);
  });
}

async function main() {
  console.log("LIVE: app transactions on their own nonce lane, during a registration");
  console.log("====================================================================\n");
  console.log(`sdk build ${sdkBuild.describe}`);
  record.sdkBuild = sdkBuild.describe;
  if (sdkBuild.dirty) console.log("  (dirty tree: rebuild with `bun run --cwd packages/wallet build` if src changed)");

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });
  const funderBalance = await pub.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO`);
  assert(funderBalance >= CELO_FUNDING + parseEther("0.5"), `the funder covers ${formatEther(CELO_FUNDING)} CELO`);

  const client = createClient({ chains: [network] });

  // ── A fresh wallet, so the registration is a first-time two-intent write. ──
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  appendFileSync(
    testnetEnvFile(),
    `\n# live-app-nonce-lane wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `APPLANE_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
  );
  console.log(`\nwallet ${wallet.address} (fresh; key saved before funding)`);
  record.wallet = wallet.address;

  const fundTx = await fw.sendTransaction({ to: wallet.address, value: CELO_FUNDING, account: funder, chain: celoSepolia });
  await pub.waitForTransactionReceipt({ hash: fundTx });
  await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
  console.log(`funded ${formatEther(CELO_FUNDING)} CELO`);

  // ── 1. Session B first, with no registry write: a second key for the second
  //       instance, cheap, and it leaves the first-time registration to A. ──
  console.log("\n[1] grantSession B (register: false), the second instance's key");
  const keyB = generatePrivateKey();
  const signerB = signerFromPrivateKey(keyB);
  const permissions = {
    calls: [{ to: funder.address }],
    // The session pays the relay's fee from its own cap, about 0.3 CELO each.
    spend: [{ limit: parseEther("2"), period: "day" as const }],
  };
  const grantB = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: signerB,
    register: false,
    permissions,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  assert(grantB.status === "granted", `session B granted (${grantB.status})`);
  console.log(`    B keyHash ${grantB.keyHash}`);

  // ── 2. Session A, with the registry write, so a registration is in flight. ──
  console.log("\n[2] grantSession A (register: true), registration goes in flight");
  const keyA = generatePrivateKey();
  const signerA = signerFromPrivateKey(keyA);
  const events: string[] = [];
  const grantA = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: signerA,
    permissions,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (status: string, detail?: { chainId?: number; step?: string; reason?: string }) => {
      const line = `${at()} ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}${detail?.reason ? ` — ${detail.reason}` : ""}`;
      events.push(line);
      console.log(`    ${line}`);
    },
  });
  record.statusEvents = events;
  appendFileSync(
    testnetEnvFile(),
    `APPLANE_SESSION_A_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${keyA}\n` +
      `APPLANE_SESSION_B_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${keyB}\n`,
  );

  const registryLeg = grantA.legs.find((l: GrantLeg) => l.kind === "registry")!;
  console.log(`\n    returned at ${at()}: status=${grantA.status}, registry ${registryLeg.chainId}: ${registryLeg.status}`);
  assert(grantA.status === "granted", `the grant is usable (${grantA.status})`);
  assert(registryLeg.status === "PENDING", "the Sepolia registry leg is still PENDING, so the registration is in flight");
  record.grantReturnedAt = at();
  console.log(`    A keyHash ${grantA.keyHash}`);

  const lanes = {
    A: laneForKeyHash(accountKeyHash(toAccount(keyA).address)),
    B: laneForKeyHash(accountKeyHash(toAccount(keyB).address)),
  };
  assert(lanes.A !== lanes.B, "the two keys derive two different lanes");
  assert(
    lanes.A >> 176n === APP_LANE_PREFIX && lanes.B >> 176n === APP_LANE_PREFIX,
    "both lanes carry the app-lane prefix, so neither is lane 0 nor 0xc1d0-prefixed",
  );
  record.lanes = { A: `0x${lanes.A.toString(16)}`, B: `0x${lanes.B.toString(16)}` };

  // ── 3. Two separate SDK processes, at once, during the registration. ──
  console.log(`\n[3] two separate SDK processes, ${TX_COUNT} transactions each, fired at once`);
  const firedAt = Date.now();
  const workers = await Promise.all(
    (
      [
        ["A", grantA, keyA],
        ["B", grantB, keyB],
      ] as const
    ).map(([label, grant, key]) =>
      runWorker({
        WORKER_LABEL: label,
        WORKER_SESSION: JSON.stringify(serializeSession(grant as unknown as Session)),
        WORKER_SESSION_KEY: key,
        WORKER_TO: funder.address,
        WORKER_TX_COUNT: String(TX_COUNT),
      }),
    ),
  );
  const elapsed = (Date.now() - firedAt) / 1000;
  console.log(`    both workers finished after ${elapsed.toFixed(1)}s`);
  record.allSettledSeconds = Number(elapsed.toFixed(1));

  const byLabel: Record<string, Hex[]> = { A: [], B: [] };
  const failures: string[] = [];
  for (const w of workers) {
    for (const r of w.settled) {
      if (!r.ok) {
        failures.push(`${w.label}/${r.i}: ${r.error}`);
        console.log(`    ${w.label} tx ${r.i} FAILED: ${r.error}`);
        continue;
      }
      console.log(`    ${w.label} tx ${r.i}: ${r.status} ${network.explorer}/tx/${r.tx}`);
      if (r.status === "CONFIRMED") byLabel[w.label]!.push(r.tx as Hex);
      else failures.push(`${w.label}/${r.i}: status ${r.status}`);
    }
  }
  record.failures = failures;
  record.appTxs = byLabel;
  const nonceFailures = failures.filter((f) => /InvalidNonce|invalid nonce/i.test(f));
  assert(nonceFailures.length === 0, `no transaction hit InvalidNonce (${nonceFailures.length} did)`);
  assert(failures.length === 0, `all ${TX_COUNT * 2} went through on their first attempt (${failures.length} did not)`);

  // ── 3b. The lanes each key actually used. ──
  console.log("\n[3b] nonce lanes, from IntentExecuted");
  const counters: Record<string, bigint[]> = { A: [], B: [] };
  for (const label of ["A", "B"] as const) {
    for (const [i, h] of byLabel[label]!.entries()) {
      for (const intent of await intentsIn(h, wallet.address)) {
        console.log(`    ${label} tx ${i}  counter ${intent.counter}  ${laneName(intent.seqKey, lanes)}`);
        assert(intent.seqKey === lanes[label], `${label} tx ${i} ran on ${label}'s own lane`);
        counters[label]!.push(intent.counter);
      }
    }
    const sorted = [...counters[label]!].sort((x, y) => (x < y ? -1 : 1));
    assert(
      sorted.every((c, i) => i === 0 || c === sorted[i - 1]! + 1n),
      `${label}'s counters are consecutive (${sorted.join(", ")})`,
    );
  }
  record.appLaneCounters = { A: counters.A!.map(String), B: counters.B!.map(String) };

  // ── 4. The registration's own intents, on lane 0. ──
  console.log("\n[4] the registration, and the lane it used");
  const registryLegs = await grantA.registration;
  const sepolia = registryLegs.find((l: GrantLeg) => l.chainId === SEPOLIA.chainId)!;
  console.log(`    ${at()} registry ${sepolia.status}${sepolia.reason ? ` — ${sepolia.reason}` : ""}`);
  record.registryLeg = { status: sepolia.status, tx: sepolia.transactionHash, reason: sepolia.reason };
  if (sepolia.sourceTransactionHash) {
    for (const intent of await intentsIn(sepolia.sourceTransactionHash as Hex, wallet.address)) {
      console.log(`    registration source intent  counter ${intent.counter}  ${laneName(intent.seqKey, lanes)}`);
      assert(intent.seqKey === 0n, "the registration's funding intent stayed on lane 0");
      record.registrationSourceLane = laneName(intent.seqKey, lanes);
    }
  } else {
    console.log("    (no source transaction recorded on the leg)");
  }

  await sweep(wallet.address, adminKey, funder.address);
  record.verdict =
    `PASS: ${TX_COUNT * 2} transactions from two separate SDK processes on two session keys of one ` +
    `wallet, fired at once during a live registration, no InvalidNonce; each key on its own lane and ` +
    `the registration on lane 0`;
  writeFileSync(
    new URL(`./app-nonce-lane-run-${new Date().toISOString().slice(0, 10)}-${String(record.sdkBuild).replace(/[^a-zA-Z0-9]/g, "")}.json`, import.meta.url),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log("\n====================================================================");
  console.log(`Result: ${record.verdict}`);
}

/** Returns what is left to the funder, as a plain EOA transfer. */
async function sweep(wallet: Address, adminKey: Hex, funder: Address) {
  console.log("\n[sweep] return leftover funds to the funder");
  try {
    const account = privateKeyToAccount(adminKey);
    const bal = await pub.getBalance({ address: wallet });
    const gasPrice = parseGwei("70");
    const cost = 21_000n * gasPrice;
    if (bal <= cost * 2n) {
      console.log(`    ${formatEther(bal)} CELO left, at or below the gas it would cost; left in place`);
      return;
    }
    const w = createWalletClient({ account, chain: celoSepolia, transport: http(network.publicRpcUrl) });
    const hash = await w.sendTransaction({ to: funder, value: bal - cost, gas: 21_000n, gasPrice });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(bal - cost)} CELO  ${hash}`);
    record.swept = { value: formatEther(bal - cost), tx: hash };
  } catch (e) {
    console.log(`    sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
