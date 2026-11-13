/**
 * LIVE (Celo Sepolia) — N wallets, each grants a session, waits until that
 * session key is POPULATED in the Celo KeyStoreCache mirror, and only THEN
 * uses it on Celo. All N in parallel. Nothing is revoked and nothing is swept:
 * the sessions stay active and the wallets keep their CELO.
 *
 * The order is the point: the session key is used only once the Celo cache
 * says it is valid, so a pass shows the whole registration-to-mirror path
 * works for several wallets at once, not just that the session can act.
 *
 *   bun run --filter '@altananetwork/e2e' live:mirror-then-use
 *
 *   WALLETS          how many (default 5)
 *   FUND_EACH        CELO per wallet (default 2.5: grant + mirror proof + one use)
 *   SESSION_DAYS     session expiry in days (default 7)
 *   EXPLORER_WAIT_S  how long to wait for the explorer to show the populated key (default 900)
 *   RUN_RECORD       where to write the JSON run record
 *   TESTNET_ENV_FILE / ALTANA_RELAY_URL / CELO_SEPOLIA_RPC_URL / SEPOLIA_RPC_URL
 *
 * Run it without a timeout: the mirror proof waits for Celo to anchor the
 * Sepolia registration block, about 20-25 minutes.
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  isCachedKeyValid,
  sdkBuild,
  signerFromPrivateKey,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { celoSepolia, sepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://testnet-relay.altana.network";
const COUNT = Number(process.env.WALLETS ?? 5);
const FUND_EACH = parseEther(process.env.FUND_EACH ?? "2.5");
const SESSION_DAYS = Number(process.env.SESSION_DAYS ?? 7);
const EXPLORER_WAIT_MS = Number(process.env.EXPLORER_WAIT_S ?? 900) * 1000;
const PROBE = parseEther("0.001");
const EXPLORER = (a: Address) => `https://testnet.altana.network/account/${a}`;

const l1Read = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  registry: {
    ...(CELO_SEPOLIA.registry as any),
    l1: { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: l1Read },
  },
} as NetworkConfig;
const CACHE = (network.registry as any)?.keyStoreCache as Address;
if (!CACHE) throw new Error("no KeyStoreCache configured for Celo Sepolia");

const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;
const sep = createPublicClient({ chain: sepolia, transport: http(l1Read) }) as PublicClient;

const t0 = Date.now();
const iso = () => new Date().toISOString();
const secs = (from: number) => `${((Date.now() - from) / 1000).toFixed(1)}s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "none");

function land(tag: string, msg: string) {
  console.log(`  ${iso()} t+${((Date.now() - t0) / 1000).toFixed(0)}s ${tag}  ${msg}`);
}

type Row = {
  tag: string;
  address: Address;
  explorer: string;
  sessionPublicKey: Hex;
  keyId?: Hex;
  grantedAt?: string;
  grantStatus?: string;
  accountTx?: Hex;
  registryTx?: Hex;
  registryBlock?: string;
  registryStatus?: string;
  registryFundedFrom?: number;
  registrySourceTx?: Hex;
  mirrorStatus?: string;
  mirrorTx?: Hex;
  mirrorL1Block?: string;
  mirrorAt?: string;
  mirrorSecondsFromGrant?: number;
  cacheValidAt?: string;
  explorerPopulatedAt?: string;
  explorerSnippet?: string;
  usedTx?: Hex;
  usedBlock?: string;
  usedStatus?: string;
  usedAt?: string;
  usedAfterMirror?: boolean;
  error?: string;
};

const record: Record<string, unknown> = { relay: RELAY, startedAt: iso(), count: COUNT, cache: CACHE };

/** Polls the explorer page for a "Key populated … key <keyId> … Celo" row. */
async function waitForExplorer(address: Address, keyId: Hex): Promise<string | undefined> {
  const keyShort = `${keyId.slice(0, 6)}…${keyId.slice(-4)}`.toLowerCase();
  const deadline = Date.now() + EXPLORER_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const html = await (await fetch(EXPLORER(address))).text();
      const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      for (const m of text.matchAll(/Key populated .{0,160}/g)) {
        const row = m[0].split(" + ")[0]!;
        if (row.toLowerCase().includes(`key ${keyShort}`) && /\bCelo\b/.test(row)) return row.trim();
      }
    } catch {
      /* the explorer being slow is not the run failing */
    }
    await sleep(15_000);
  }
  return undefined;
}

async function main() {
  console.log(`LIVE: ${COUNT} wallets, session mirrored into the Celo cache, then used`);
  console.log(`sdk build ${sdkBuild.describe}\nrelay ${RELAY}\ncache ${CACHE}`);
  record.sdkBuild = sdkBuild.describe;

  const envFile = testnetEnvFile();
  const funderKey = process.env.TEST_FUNDER_KEY as Hex | undefined;
  if (!funderKey) throw new Error("TEST_FUNDER_KEY is not set");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });

  const need = FUND_EACH * BigInt(COUNT);
  const funderBalance = await pub.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO (needs ${formatEther(need)})`);
  if (funderBalance < need) throw new Error(`funder short: ${formatEther(funderBalance)} < ${formatEther(need)}`);

  // Keys first, funds second: admin key AND session key, before any funding.
  const stamp = Date.now();
  const wallets = Array.from({ length: COUNT }, (_, i) => {
    const key = generatePrivateKey();
    const sessionKey = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const sessionPublicKey = signerFromPrivateKey(sessionKey).publicKey as Hex;
    appendFileSync(
      envFile,
      `\n# throwaway, ${COUNT}-wallet public-relay mirror-then-use run ${iso()} (w${i + 1}); session left ACTIVE, not swept\n` +
        `THROWAWAY_MIRROR_${stamp}_${i + 1}_KEY=${key}\n` +
        `THROWAWAY_MIRROR_${stamp}_${i + 1}_ADDRESS=${address}\n` +
        `THROWAWAY_MIRROR_${stamp}_${i + 1}_SESSION_KEY=${sessionKey}\n` +
        `THROWAWAY_MIRROR_${stamp}_${i + 1}_SESSION_PUBKEY=${sessionPublicKey}\n`,
    );
    const row: Row = { tag: `w${i + 1}`, address, explorer: EXPLORER(address), sessionPublicKey };
    return { key, sessionKey, row };
  });
  record.envPrefix = `THROWAWAY_MIRROR_${stamp}_`;
  console.log(`\n${COUNT} wallets: admin and session keys written to the shared env file (prefix THROWAWAY_MIRROR_${stamp}_)\n`);

  const baseNonce = await pub.getTransactionCount({ address: funder.address });
  const fundHashes = await Promise.all(
    wallets.map((w, i) => fw.sendTransaction({ to: w.row.address, value: FUND_EACH, nonce: baseNonce + i })),
  );
  await Promise.all(fundHashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  wallets.forEach((w) => land(w.row.tag, `funded ${formatEther(FUND_EACH)} CELO`));
  record.fundingTxs = fundHashes;

  const client = createClient({ chains: [network] });

  async function run(w: (typeof wallets)[number]): Promise<void> {
    const r = w.row;
    const signer = signerFromPrivateKey(w.key);
    const created = await client.createWallet({ signer });
    land(r.tag, `wallet created ${r.explorer}`);

    const grantStart = Date.now();
    const grant = await client.grantSession({
      wallet: created,
      signer,
      sessionSigner: signerFromPrivateKey(w.sessionKey),
      permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("1"), period: "day" }] },
      expiry: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86_400,
      // Default population, kept running in the background; awaited below.
      populateCache: true,
      onStatus: (status: string) => {
        if (status === "cache-sync") land(r.tag, "mirror proof submitting (Celo anchored the registration block)");
      },
    });
    r.grantedAt = iso();
    r.grantStatus = grant.status;
    r.keyId = (grant as any).keyId;
    r.accountTx = grant.legs.find((l) => l.kind === "account")?.transactionHash;
    land(r.tag, `session granted (${grant.status}) in ${secs(grantStart)}, Celo authorization ${r.accountTx}`);

    const reg = (await grant.registration).find((l) => l.kind === "registry");
    r.registryStatus = reg?.status;
    r.registryTx = reg?.transactionHash;
    r.registryFundedFrom = reg?.fundedFromChainId;
    r.registrySourceTx = reg?.sourceTransactionHash;
    if (reg?.blockNumber !== undefined) r.registryBlock = reg.blockNumber.toString();
    else if (r.registryTx) r.registryBlock = (await sep.waitForTransactionReceipt({ hash: r.registryTx })).blockNumber.toString();
    land(r.tag, `Sepolia KeyStore registration ${r.registryStatus} ${r.registryTx} block ${r.registryBlock}`);
    if (r.registryStatus !== "CONFIRMED") throw new Error(`registration ${r.registryStatus}: ${reg?.reason ?? "no reason"}`);

    const cache = (await grant.cacheSync).find((l) => l.kind === "cache");
    r.mirrorStatus = cache?.status;
    r.mirrorTx = cache?.transactionHash;
    r.mirrorL1Block = cache?.l1BlockNumber?.toString();
    r.mirrorAt = iso();
    r.mirrorSecondsFromGrant = Math.round((Date.now() - grantStart) / 1000);
    land(r.tag, `mirror proof ${r.mirrorStatus} ${r.mirrorTx} (L1 block ${r.mirrorL1Block}) ${r.mirrorSecondsFromGrant}s after the grant started`);
    if (r.mirrorStatus !== "CONFIRMED") throw new Error(`mirror proof ${r.mirrorStatus}: ${cache?.reason ?? "no reason"}`);

    // The authoritative check: the cache's own isValidKey, before any use.
    for (let i = 0; ; i++) {
      if (await isCachedKeyValid(pub, CACHE, r.address, r.keyId!)) break;
      if (i >= 40) throw new Error("mirror proof confirmed but KeyStoreCacheOPStack.isValidKey stayed false");
      await sleep(15_000);
    }
    r.cacheValidAt = iso();
    land(r.tag, "KeyStoreCacheOPStack.isValidKey = true on Celo");

    const row = await waitForExplorer(r.address, r.keyId!);
    if (row) {
      r.explorerPopulatedAt = iso();
      r.explorerSnippet = row;
      land(r.tag, `explorer: ${row}`);
    } else {
      land(r.tag, `explorer did not show the populated key within ${EXPLORER_WAIT_MS / 1000}s; using the session anyway (cache read is authoritative)`);
    }

    // Only now: one transaction signed by the session key on Celo.
    const used = await client.execute({
      session: grant as unknown as Session,
      chainId: network.chainId,
      calls: { to: funder.address, value: PROBE, data: "0x" as Hex },
    });
    r.usedTx = used.transactionHash as Hex | undefined;
    r.usedAt = iso();
    if (r.usedTx) {
      const receipt = await pub.waitForTransactionReceipt({ hash: r.usedTx });
      r.usedStatus = receipt.status;
      r.usedBlock = receipt.blockNumber.toString();
    } else {
      r.usedStatus = String(used.status);
    }
    r.usedAfterMirror = Date.parse(r.usedAt) > Date.parse(r.cacheValidAt);
    land(r.tag, `session used on Celo ${r.usedTx} (${r.usedStatus}, block ${r.usedBlock})`);
  }

  const outcomes = await Promise.allSettled(wallets.map((w) => run(w)));
  outcomes.forEach((o, i) => {
    if (o.status === "rejected") {
      const r = wallets[i]!.row;
      r.error = o.reason instanceof Error ? o.reason.message.split("\n")[0] : String(o.reason);
      land(r.tag, `FAILED: ${r.error}`);
    }
  });

  const rows = wallets.map((w) => w.row);
  record.wallets = rows;
  const ok = rows.filter((r) => r.mirrorStatus === "CONFIRMED" && r.cacheValidAt && r.usedStatus === "success" && r.usedAfterMirror);
  record.passed = ok.map((r) => r.tag);
  record.failed = rows.filter((r) => !ok.includes(r)).map((r) => r.tag);
  record.verdict = ok.length === COUNT ? "PASS" : "FAIL";
  record.finishedAt = iso();
  record.funderAfter = formatEther(await pub.getBalance({ address: funder.address }));
  console.log(`\nResult: ${record.verdict} — ${ok.length}/${COUNT} used their session after the mirror landed. No revoke, no sweep.`);
}

main()
  .catch((err) => {
    record.verdict = "FAIL";
    record.error = err instanceof Error ? err.message : String(err);
    console.error(`\nResult: FAIL — ${record.error}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const path = process.env.RUN_RECORD ?? `many-wallets-mirror-then-use-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`run record ${path}`);
    // Open sockets must not keep the process alive once the record is written.
    setTimeout(() => process.exit(process.exitCode ?? 0), 2_000);
  });
