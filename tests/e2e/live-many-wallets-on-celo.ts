/**
 * LIVE (Celo Sepolia, via relay-staging) — N wallets appear with their
 * sessions on Celo at the same time.
 *
 * Built for Doris to watch: every wallet is created, granted a session and
 * then USES that session, all N in flight at once, and each milestone prints
 * the moment it lands with its explorer link. The Sepolia KeyStore
 * registration runs in the background per wallet (Celo-first, PR #113), so
 * the session acts before its registry record exists — which is the property
 * worth watching, not an accident of timing.
 *
 *   bun run tests/e2e/live-many-wallets-on-celo.ts
 *
 *   WALLETS         how many (default 5)
 *   FUND_EACH       CELO per wallet (default 1.8)
 *   EVIDENCE_FILE   append each milestone here as it lands
 *   TESTNET_ENV_FILE  the shared .env.testnet (required outside the repo tree)
 *   ALTANA_RELAY_URL / CELO_SEPOLIA_RPC_URL / SEPOLIA_RPC_URL  overrides
 *
 * Funds: every key is written to the shared env file BEFORE its wallet is
 * funded, and whatever is left comes back to the funder at the end.
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  sdkBuild,
  signerFromPrivateKey,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const COUNT = Number(process.env.WALLETS ?? 5);
const FUND_EACH = parseEther(process.env.FUND_EACH ?? "1.8");
/** What each session sends, to prove the session itself can act. */
const PROBE = parseEther("0.001");
/** Reserve left behind when sweeping, sized from a quote in the sweep itself. */
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

const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;

const t0 = Date.now();
const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const evidencePath = process.env.EVIDENCE_FILE;
const lines: string[] = [];

/** Prints a milestone and appends it to the evidence file the moment it lands. */
function land(tag: string, msg: string) {
  const line = `| ${at().padEnd(9)} | ${tag.padEnd(3)} | ${msg} |`;
  lines.push(line);
  console.log(`  ${at().padEnd(9)} ${tag}  ${msg}`);
  if (evidencePath) {
    try {
      appendFileSync(evidencePath, `${line}\n`);
    } catch (err) {
      console.log(`    (evidence append failed: ${(err as Error).message})`);
    }
  }
}

function note(text: string) {
  console.log(text);
  if (evidencePath) {
    try {
      appendFileSync(evidencePath, `${text}\n`);
    } catch {
      /* the run matters more than its transcript */
    }
  }
}

type Wallet = {
  tag: string;
  key: Hex;
  address: Address;
  signer: ReturnType<typeof signerFromPrivateKey>;
  sessionKey: Hex;
  grantedAt?: string;
  accountTx?: Hex;
  sessionTx?: Hex;
  registryTx?: Hex;
  registryStatus?: string;
  error?: string;
};

const record: Record<string, unknown> = {
  relay: RELAY,
  startedAt: new Date().toISOString(),
  count: COUNT,
};

async function main() {
  console.log(`LIVE: ${COUNT} wallets appearing with their sessions on Celo Sepolia`);
  console.log("=".repeat(70));
  console.log(`\nsdk build ${sdkBuild.describe}`);
  if (sdkBuild.describe.includes("dirty")) {
    console.log("  (dirty tree: run `bun run --cwd packages/wallet build` if you changed src since)");
  }
  record.sdkBuild = sdkBuild.describe;
  console.log(`relay ${RELAY}`);

  const envFile = testnetEnvFile();
  const funderKey = process.env.TEST_FUNDER_KEY as Hex | undefined;
  if (!funderKey) throw new Error(`TEST_FUNDER_KEY is not set (load ${envFile} first)`);
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });

  const need = FUND_EACH * BigInt(COUNT);
  const funderBalance = await pub.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO (needs ${formatEther(need)})`);
  if (funderBalance < need) {
    throw new Error(`the funder holds ${formatEther(funderBalance)} CELO, short of the ${formatEther(need)} this run needs`);
  }

  // Keys first, funds second: a run that dies between the two must not strand
  // anything (pm's rule of 2026-10-20, after two wallets were lost that way).
  //
  // BOTH keys, admin and session. The 2026-10-21 run saved only the admin key,
  // and when one wallet's KeyStore registration stalled, its session key
  // turned out to be unrecoverable: the KeyStore never received the public
  // key, and the account stores a secp256k1 key as its 20-byte address
  // left-padded to 32 bytes, which cannot be reversed into a public key. That
  // session could never be mirrored into the Celo cache, and the whole of what
  // was missing is the two extra lines below.
  const wallets: Wallet[] = [];
  const stamp = Date.now();
  for (let i = 0; i < COUNT; i++) {
    const key = generatePrivateKey();
    const sessionKey = generatePrivateKey();
    const signer = signerFromPrivateKey(key);
    const address = privateKeyToAccount(key).address;
    appendFileSync(
      envFile,
      `\n# throwaway, ${COUNT}-wallet Celo run ${new Date().toISOString()} (w${i + 1})\n` +
        `THROWAWAY_MANY_${stamp}_${i + 1}_KEY=${key}\n` +
        `THROWAWAY_MANY_${stamp}_${i + 1}_ADDRESS=${address}\n` +
        `THROWAWAY_MANY_${stamp}_${i + 1}_SESSION_KEY=${sessionKey}\n` +
        `THROWAWAY_MANY_${stamp}_${i + 1}_SESSION_PUBKEY=${signerFromPrivateKey(sessionKey).publicKey}\n`,
    );
    wallets.push({ tag: `w${i + 1}`, key, address, signer, sessionKey });
  }
  console.log(`\n${COUNT} wallets: admin key, session key and session public key written to the shared env file before any funding\n`);

  if (evidencePath && !existsSync(evidencePath)) {
    writeFileSync(evidencePath, "");
  }
  note(`# ${COUNT} wallets with sessions on Celo Sepolia — ${new Date().toISOString()}`);
  note("");
  note(`Relay \`${RELAY}\`, SDK build \`${sdkBuild.describe}\`. Every wallet is created,`);
  note("granted a session and then uses that session, all at once. The Sepolia KeyStore");
  note("registration runs in the background per wallet, so a session acts before its");
  note("registry record exists.");
  note("");
  for (const w of wallets) {
    note(`- ${w.tag} [\`${w.address}\`](${EXPLORER(w.address)})`);
  }
  note("");
  note("| when | wallet | what |");
  note("|---|---|---|");

  // One nonce read, then all funding transactions at once: the funder is a
  // plain EOA, so concurrent sends without explicit nonces would collide.
  const baseNonce = await pub.getTransactionCount({ address: funder.address });
  const fundHashes = await Promise.all(
    wallets.map((w, i) =>
      fw.sendTransaction({ to: w.address, value: FUND_EACH, nonce: baseNonce + i }).then((hash) => {
        land(w.tag, `funded ${formatEther(FUND_EACH)} CELO`);
        return hash;
      }),
    ),
  );
  await Promise.all(fundHashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  record.fundingTxs = fundHashes;

  const client = createClient({ chains: [network] });

  /** One wallet's whole life: create, grant, use the session, then register. */
  async function run(w: Wallet): Promise<void> {
    const created = await client.createWallet({ signer: w.signer });
    land(w.tag, `wallet created — ${EXPLORER(w.address)}`);

    let failureSeen = false;
    const sessionSigner = signerFromPrivateKey(w.sessionKey);
    const grant = await client.grantSession({
      wallet: created,
      signer: w.signer,
      sessionSigner,
      permissions: {
        calls: [{ to: funder.address }],
        // The session pays the relay's fee from its own native cap, and that
        // fee is about 0.4 CELO at the deployed intent buffer: a smaller cap
        // is not a tight session, it is an unusable one.
        spend: [{ limit: parseEther("1"), period: "day" }],
      },
      expiry: Math.floor(Date.now() / 1000) + 3600,
      // No cache proof: it waits for Celo to anchor the Sepolia block, which
      // took 24 minutes on 2026-10-17 and is not what we are watching.
      populateCache: false,
      onStatus: (status: string, detail?: { chainId?: number; step?: string; reason?: string }) => {
        if (status === "account-authorization") land(w.tag, "authorizing the session key on Celo");
        if (status === "registry-write" && detail?.step) land(w.tag, `Sepolia registration (${detail.step}) started`);
        // Deliberately not reported here: the registry leg below carries the
        // same failure with the same reason, and emitting both printed every
        // failure twice into the evidence file.
        if (status === "registry-write-failed") failureSeen = true;
      },
    });
    w.grantedAt = at();
    const accountLeg = grant.legs.find((l: any) => l.kind === "account" && l.chainId === network.chainId);
    w.accountTx = accountLeg?.transactionHash;
    const registryLeg = grant.legs.find((l: any) => l.kind === "registry");
    land(
      w.tag,
      `**session granted** (${grant.status}), Celo authorization [\`${short(w.accountTx)}\`](https://sepolia.celoscan.io/tx/${w.accountTx})` +
        `, Sepolia registry leg ${registryLeg?.status ?? "n/a"}`,
    );

    // The point of Celo-first: the session can act now, with the Sepolia
    // registration still in flight.
    // The grant result IS the session (Session & { keyId, keyHash, ... }).
    const session = grant as unknown as Session;
    const used = await client.execute({
      session,
      chainId: network.chainId,
      calls: { to: funder.address, value: PROBE, data: "0x" as Hex },
    });
    w.sessionTx = used.transactionHash as Hex | undefined;
    land(
      w.tag,
      `**session used on Celo** — [\`${short(w.sessionTx)}\`](https://sepolia.celoscan.io/tx/${w.sessionTx})` +
        ` (${used.status})`,
    );

    const legs = await grant.registration;
    if (failureSeen) record.sawRegistryWriteFailedEvent = true;
    const reg = legs.find((l: any) => l.kind === "registry");
    w.registryStatus = reg?.status;
    w.registryTx = reg?.transactionHash;
    land(
      w.tag,
      w.registryStatus === "CONFIRMED"
        ? `Sepolia KeyStore registration confirmed — [\`${short(w.registryTx)}\`](https://sepolia.etherscan.io/tx/${w.registryTx})`
        : `**Sepolia registration ${w.registryStatus ?? "unknown"}** — ${reg?.reason ?? "no reason reported"}`,
    );
  }

  const outcomes = await Promise.allSettled(wallets.map((w) => run(w)));
  outcomes.forEach((o, i) => {
    if (o.status === "rejected") {
      const w = wallets[i]!;
      w.error = o.reason instanceof Error ? o.reason.message.split("\n")[0] : String(o.reason);
      land(w.tag, `**failed** — ${w.error}`);
    }
  });

  record.wallets = wallets.map((w) => ({
    tag: w.tag,
    address: w.address,
    explorer: EXPLORER(w.address),
    // Public, not secret, and the one value a later cache proof needs: a
    // session key that never reached the KeyStore cannot be mirrored without it.
    sessionPublicKey: signerFromPrivateKey(w.sessionKey).publicKey,
    grantedAt: w.grantedAt,
    accountTx: w.accountTx,
    sessionTx: w.sessionTx,
    registryTx: w.registryTx,
    registryStatus: w.registryStatus,
    ...(w.error ? { error: w.error } : {}),
  }));

  const granted = wallets.filter((w) => w.accountTx).length;
  const used = wallets.filter((w) => w.sessionTx).length;
  const registered = wallets.filter((w) => w.registryStatus === "CONFIRMED").length;
  note("");
  note(`**${granted}/${COUNT} granted on Celo, ${used}/${COUNT} sessions used, ${registered}/${COUNT} registered in the Sepolia KeyStore.**`);
  record.summary = { granted, used, registered, count: COUNT };

  // Sweep: every wallet returns what is left, sized from its own balance less
  // a gas reserve measured here rather than guessed.
  note("");
  let returned = 0n;
  for (const w of wallets) {
    try {
      const balance = await pub.getBalance({ address: w.address });
      const wc = createWalletClient({ account: privateKeyToAccount(w.key), chain: celoSepolia, transport: http(network.publicRpcUrl) });
      const gas = 21_000n;
      const fees = await pub.estimateFeesPerGas();
      const reserve = gas * (fees.maxFeePerGas ?? parseEther("0.000000005")) * 2n;
      if (balance <= reserve) {
        console.log(`  ${w.tag} holds ${formatEther(balance)} CELO, below the gas reserve; left in place`);
        continue;
      }
      const hash = await wc.sendTransaction({ to: funder.address, value: balance - reserve, gas });
      await pub.waitForTransactionReceipt({ hash });
      returned += balance - reserve;
      console.log(`  ${w.tag} returned ${formatEther(balance - reserve)} CELO  ${hash}`);
    } catch (err) {
      console.log(`  ${w.tag} sweep failed: ${(err as Error).message.split("\n")[0]} (key is in the env file)`);
    }
  }
  note(`Swept ${formatEther(returned)} CELO back to the funder; every key is in the shared env file.`);
  record.returned = formatEther(returned);
  record.funderAfter = formatEther(await pub.getBalance({ address: funder.address }));
  console.log(`\nfunder now holds ${record.funderAfter} CELO`);
}

const short = (h?: Hex) => (h ? `${h.slice(0, 10)}…` : "none");

main()
  .then(() => {
    // A run that completed is not a run that succeeded: the verdict is the
    // per-wallet counts, or a wallet silently failing reads as a green run.
    const s = record.summary as { granted: number; used: number; registered: number; count: number } | undefined;
    const all = s ? s.granted === s.count && s.used === s.count && s.registered === s.count : false;
    record.verdict = all ? "PASS" : "PARTIAL";
    console.log(`\n${"=".repeat(70)}`);
    console.log(
      all
        ? `Result: PASS — ${s!.count}/${s!.count} wallets granted, used their session and registered.`
        : `Result: PARTIAL — ${s?.granted ?? 0}/${s?.count ?? COUNT} granted, ${s?.used ?? 0} used, ${s?.registered ?? 0} registered. See the lines above.`,
    );
    note("");
    note(`Verdict: ${record.verdict}.`);
  })
  .catch((err) => {
    record.verdict = "FAIL";
    record.error = err instanceof Error ? err.message : String(err);
    console.error(`\nResult: FAIL — ${record.error}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const stamp = String(record.sdkBuild ?? "unknown").replace(/[^a-zA-Z0-9]/g, "");
    const path = new URL(`./many-wallets-run-${new Date().toISOString().slice(0, 10)}-${stamp}.json`, import.meta.url);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`run record ${path.pathname.split("/").pop()}`);
  });
