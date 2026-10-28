/**
 * LIVE (Celo Sepolia, via relay-staging) — finish what the 5-wallet run
 * started: every session key's registry state mirrored into the Celo
 * KeyStoreCache, so the explorer shows it on Celo.
 *
 * Follows `live-many-wallets-on-celo.ts` (grants at 11:46:17 UTC on
 * 2026-10-21). Reads the five admin keys back out of the shared env file,
 * refunds each wallet, retries the one registration that stalled, then proves
 * each session key into the cache as soon as Celo's anchor passes that
 * wallet's Sepolia registration block. Keeps retrying until each lands.
 *
 * Every time is measured from the ORIGINAL grant, not from this process.
 *
 * No sweep and no revoke: the wallets keep their funds.
 *
 *   bun run tests/e2e/live-mirror-the-five.ts
 *
 *   DEADLINE_UTC   stop and report FAIL after this (default 12:40 UTC)
 *   EVIDENCE_FILE  append the timings here
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  registerSessionKey,
  sdkBuild,
  signerFromPrivateKey,
  syncSessionToCache,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import { deriveKeyId, readActiveKeys, readPublicKey } from "../../packages/wallet/dist/internal/keystore.js";
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
import { privateKeyToAccount } from "viem/accounts";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";
import runRecord from "./many-wallets-run-2026-10-21-d65bdfcdirty.json" with { type: "json" };

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const REFUND = parseEther("0.6");
/** The original grant, the clock every time below is measured from. */
const GRANT_AT = Date.parse("2026-10-21T11:46:17.893Z");
const DEADLINE = Date.parse(`2026-10-21T${process.env.DEADLINE_UTC ?? "12:40"}:00Z`);
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
const sep = createPublicClient({ transport: http(l1Read) }) as PublicClient;

/** Minutes and seconds since the original grant. */
const since = () => {
  const s = (Date.now() - GRANT_AT) / 1000;
  return `T+${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
};
const evidencePath = process.env.EVIDENCE_FILE;

function note(text: string) {
  console.log(text);
  if (evidencePath) {
    try {
      appendFileSync(evidencePath, `${text}\n`);
    } catch (err) {
      console.log(`  (evidence append failed: ${(err as Error).message})`);
    }
  }
}
function land(tag: string, what: string) {
  note(`| ${since().padEnd(10)} | ${tag.padEnd(3)} | ${what} |`);
}

type W = {
  tag: string;
  address: Address;
  key: Hex;
  signer: ReturnType<typeof signerFromPrivateKey>;
  registryStatus: string;
  registryTx?: Hex;
  sessionPublicKey?: Hex;
  provenKey?: "session" | "root";
  sessionExpiry?: number;
  registryBlock?: bigint;
  anchorAt?: string;
  proofTx?: Hex;
  proofAt?: string;
  explorerAt?: string;
  error?: string;
};

const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString(), grantAt: new Date(GRANT_AT).toISOString() };

/** The admin key for each wallet, read back out of the shared env file by address. */
function keysFromEnvFile(addresses: readonly Address[]): Map<string, Hex> {
  const text = readFileSync(testnetEnvFile(), "utf8");
  const keys = [...text.matchAll(/^THROWAWAY_MANY_\d+_\d+_KEY=(0x[0-9a-fA-F]{64})$/gm)].map((m) => m[1] as Hex);
  const byAddress = new Map<string, Hex>();
  for (const k of keys) byAddress.set(privateKeyToAccount(k).address.toLowerCase(), k);
  const found = new Map<string, Hex>();
  for (const a of addresses) {
    const k = byAddress.get(a.toLowerCase());
    if (!k) throw new Error(`no key for ${a} in ${testnetEnvFile()} — refusing to guess`);
    found.set(a.toLowerCase(), k);
  }
  return found;
}

/**
 * The session public key the grant run wrote down, if it did: the run record
 * first, then the shared env file. Public, so neither is a secret; it is the
 * one value that makes a stalled registration retryable later.
 */
function savedSessionPublicKey(w: W): Hex | undefined {
  const fromRecord = ((runRecord as any).wallets as any[]).find((r) => r.tag === w.tag)?.sessionPublicKey;
  if (typeof fromRecord === "string" && /^0x04[0-9a-fA-F]{128}$/.test(fromRecord)) return fromRecord as Hex;
  const text = readFileSync(testnetEnvFile(), "utf8");
  for (const m of text.matchAll(/^THROWAWAY_MANY_\d+_(\d+)_SESSION_PUBKEY=(0x04[0-9a-fA-F]{128})$/gm)) {
    const addressLine = new RegExp(`^THROWAWAY_MANY_\\d+_${m[1]}_ADDRESS=(0x[0-9a-fA-F]{40})$`, "m").exec(text);
    if (addressLine?.[1]?.toLowerCase() === w.address.toLowerCase()) return m[2] as Hex;
  }
  return undefined;
}

async function main() {
  console.log("LIVE: mirror all five session keys into the Celo KeyStoreCache");
  console.log("=".repeat(70));
  console.log(`\nsdk build ${sdkBuild.describe}`);
  console.log(`relay ${RELAY}`);
  console.log(`cache ${(network as any).keyStoreCache}`);
  console.log(`now ${since()} after the original grant; deadline ${new Date(DEADLINE).toISOString()}\n`);
  record.sdkBuild = sdkBuild.describe;
  record.keyStoreCache = (network as any).keyStoreCache;

  const rows = (runRecord as any).wallets as { tag: string; address: Address; registryStatus: string; registryTx?: Hex }[];
  const keys = keysFromEnvFile(rows.map((r) => r.address));
  const wallets: W[] = rows.map((r) => {
    const key = keys.get(r.address.toLowerCase())!;
    return { tag: r.tag, address: r.address, key, signer: signerFromPrivateKey(key), registryStatus: r.registryStatus, registryTx: r.registryTx };
  });

  const funderKey = process.env.TEST_FUNDER_KEY as Hex | undefined;
  if (!funderKey) throw new Error("TEST_FUNDER_KEY is not set");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });

  note("");
  note("## Mirror proofs: refund, retry w3, populate the Celo cache");
  note("");
  note(`Continued at ${new Date().toISOString()} (${since()}). Times below are from the`);
  note("original grant. No sweep and no revoke: the wallets keep their 0.6 CELO.");
  note("");
  note("| when | wallet | what |");
  note("|---|---|---|");

  // 1. Refund. One nonce read, then all five at once.
  if (process.env.SKIP_REFUND === "1") {
    for (const w of wallets) land(w.tag, `already refunded ${formatEther(REFUND)} CELO (earlier in this round)`);
  } else {
  const baseNonce = await pub.getTransactionCount({ address: funder.address });
  const hashes = await Promise.all(
    wallets.map((w, i) => fw.sendTransaction({ to: w.address, value: REFUND, nonce: baseNonce + i })),
  );
  await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  for (const w of wallets) land(w.tag, `refunded ${formatEther(REFUND)} CELO`);
  record.refundTxs = hashes;
  }

  // 2. Recover each session key's PUBLIC key.
  //
  //    Not from the account: `IthacaAccount` stores a secp256k1 key as its
  //    20-byte address left-padded to 32 bytes (measured on w1:
  //    `0x000…0c05d36ab…`), and an address cannot be turned back into a
  //    public key. The KeyStore does store the 65-byte SEC1 key, so that is
  //    the source — which means a key the KeyStore never received cannot be
  //    mirrored at all. That is w3, and it is a gap in the first run's
  //    bookkeeping: it saved every admin key before funding and never saved
  //    the session keys.
  for (const w of wallets) {
    const registry = (network.registry as any).l1 as NetworkConfig;
    const ids = await readActiveKeys(sep as never, registry as never, w.address);
    const adminId = deriveKeyId(w.signer.publicKey);
    const sessionIds = ids.filter((id: Hex) => id.toLowerCase() !== adminId.toLowerCase());
    if (sessionIds.length === 1) {
      const pk = await readPublicKey(sep as never, registry as never, w.address, sessionIds[0]!);
      w.sessionPublicKey = pk;
      w.provenKey = "session";
      land(w.tag, `session public key read from the Sepolia KeyStore \`${pk.slice(0, 14)}…\``);
      continue;
    }
    // Not in the KeyStore. Second source: the public key the grant run wrote
    // down, in its run record or in the shared env file. With it, the
    // registration can be retried and the real session key mirrored; the
    // 2026-10-21 run had neither, which is why that wallet fell through to
    // its root key.
    const saved = savedSessionPublicKey(w);
    if (saved) {
      w.sessionPublicKey = saved;
      w.provenKey = "session";
      land(w.tag, `session public key taken from the run's own record \`${saved.slice(0, 14)}…\` (not yet in the KeyStore)`);
      continue;
    }

    // Neither source has it, so the key is gone: the account stores only the
    // address and an address cannot be reversed into a public key. Mirror the
    // wallet's ROOT key instead — it IS registered, the cache entry is what
    // the explorer reads, and naming which key was proven is the honest
    // version of this.
    w.sessionPublicKey = w.signer.publicKey;
    w.provenKey = "root";
    land(
      w.tag,
      `**its session public key is unrecoverable** (never in the KeyStore, nothing saved by the grant run, and the account keeps only the address), ` +
        `so the mirror proof below is for the wallet's ROOT key \`${w.signer.publicKey.slice(0, 14)}…\``,
    );
  }

  // 3. w3's registration never left the relay's interop queue. registerSessionKey
  //    sees the admin root already registered, so it sends registerKey alone —
  //    and proves it into the cache itself once the write confirms.
  const stalled = wallets.filter((w) => w.registryStatus !== "CONFIRMED" && w.provenKey === "session");
  for (const w of wallets.filter((x) => x.registryStatus !== "CONFIRMED" && x.provenKey !== "session")) {
    land(w.tag, "registerKey cannot be retried: the key it would register is the one whose public key is lost");
  }
  for (const w of stalled) {
    land(w.tag, "retrying the session registration (registerKey only)");
    const session = {
      walletAddress: w.address,
      signer: w.signer,
      publicKey: w.sessionPublicKey!,
      permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("1"), period: "day" as const }] },
      expiry: w.sessionExpiry!,
    } as Session;
    const r = await registerSessionKey({ address: w.address } as never, w.signer, session, { network });
    if ((r as any).alreadyRegistered) {
      land(w.tag, "the KeyStore already had it after all");
      w.registryStatus = "CONFIRMED";
    } else {
      const reg = (r as any).registry;
      w.registryStatus = reg?.status;
      w.registryTx = reg?.transactionHash;
      land(
        w.tag,
        w.registryStatus === "CONFIRMED"
          ? `**registerKey retry confirmed** — [\`${w.registryTx?.slice(0, 10)}…\`](https://sepolia.etherscan.io/tx/${w.registryTx})`
          : `**registerKey retry ${w.registryStatus}** — ${reg?.reason ?? "no reason"}`,
      );
      const cache = (r as any).cache;
      if (cache?.status === "CONFIRMED") {
        w.proofTx = cache.transactionHash;
        w.proofAt = since();
        land(w.tag, `**mirror proof confirmed** (from the retry) — [\`${String(w.proofTx).slice(0, 10)}…\`](https://sepolia.celoscan.io/tx/${w.proofTx})`);
      } else if (cache) {
        land(w.tag, `the retry's cache proof reported ${cache.status}: ${cache.reason ?? "no reason"} — falling back to a direct proof`);
      }
    }
  }

  // 4. The registration block each proof must be anchored past.
  for (const w of wallets) {
    if (!w.registryTx) {
      // Proving the root: its write landed in the first run's root
      // registration, long since anchored, so prove against the current
      // anchor rather than waiting for a block we did not record.
      land(w.tag, "no session registration block to wait for; proving against the current anchor");
      continue;
    }
    try {
      const receipt = await sep.getTransactionReceipt({ hash: w.registryTx });
      w.registryBlock = receipt.blockNumber;
      land(w.tag, `Sepolia registration is in block ${receipt.blockNumber}`);
    } catch (err) {
      land(w.tag, `could not read the registration block: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  // 5. The proofs. syncSessionToCache waits for the anchor to pass the block
  //    and rebuilds against a newer anchor on rejection; the loop around it is
  //    for the case where it exhausts its attempts before the anchor arrives.
  async function prove(w: W): Promise<void> {
    if (w.proofTx) return;
    const already = (process.env.ALREADY_PROVEN ?? "")
      .split(",")
      .map((pair) => pair.split("="))
      .find(([tag]) => tag === w.tag);
    if (already?.[1]) {
      w.proofTx = already[1] as Hex;
      w.proofAt = process.env.ALREADY_PROVEN_AT ?? "earlier this round";
      land(w.tag, `mirror proof already confirmed earlier this round — [\`${already[1].slice(0, 10)}…\`](https://sepolia.celoscan.io/tx/${already[1]})`);
      return;
    }
    for (let round = 1; Date.now() < DEADLINE; round++) {
      try {
        const r = await syncSessionToCache({ address: w.address } as never, w.signer, w.sessionPublicKey!, {
          network,
          // CURRENT_ANCHOR=1 drops the afterL1Block pin. A registration that
          // was anchored minutes ago needs no pin, and pinning it made four
          // proofs sit silently while the one unpinned proof went through.
          ...(w.registryBlock !== undefined && process.env.CURRENT_ANCHOR !== "1" ? { afterL1Block: w.registryBlock } : {}),
          requireKeyInProof: true,
          maxAttempts: 8,
          onStatus: (status: string, detail: { attempt: number; l1BlockNumber?: bigint }) => {
            if (status === "anchor-reached" || status === "waiting-for-anchor") {
              if (!w.anchorAt && detail.l1BlockNumber !== undefined && w.registryBlock !== undefined && detail.l1BlockNumber >= w.registryBlock) {
                w.anchorAt = since();
                land(w.tag, `Celo anchor reached Sepolia block ${detail.l1BlockNumber} (>= ${w.registryBlock})`);
              }
            }
            if (status === "submitting-proof") land(w.tag, `submitting the mirror proof (attempt ${detail.attempt})`);
          },
        });
        if (r.status === "CONFIRMED") {
          w.proofTx = r.transactionHash as Hex;
          w.proofAt = since();
          land(w.tag, `**mirror proof confirmed** — [\`${String(w.proofTx).slice(0, 10)}…\`](https://sepolia.celoscan.io/tx/${w.proofTx})`);
          return;
        }
        land(w.tag, `proof round ${round} reported ${r.status}: ${(r as any).reason ?? "no reason"} — retrying`);
      } catch (err) {
        land(w.tag, `proof round ${round} threw: ${(err as Error).message.split("\n")[0]} — retrying`);
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
    w.error = "no proof landed before the deadline";
  }

  await Promise.all(wallets.map((w) => prove(w)));

  // 6. The explorer is the thing Doris reads, so it is the thing we assert.
  async function explorerShowsCelo(w: W): Promise<boolean> {
    try {
      const res = await fetch(EXPLORER(w.address), { headers: { accept: "text/html" } });
      const body = await res.text();
      const hay = body.replace(/\s+/g, " ");
      return /Key populated[^<]{0,80}Celo/i.test(hay) || (/populated/i.test(hay) && /Celo/i.test(hay) && hay.includes(w.address.slice(2, 10)));
    } catch {
      return false;
    }
  }
  for (const w of wallets) {
    if (!w.proofTx) continue;
    while (Date.now() < DEADLINE) {
      if (await explorerShowsCelo(w)) {
        w.explorerAt = since();
        land(w.tag, `explorer shows the key populated on Celo — ${EXPLORER(w.address)}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    if (!w.explorerAt) land(w.tag, `the explorer still does not show Celo — ${EXPLORER(w.address)}`);
  }

  record.wallets = wallets.map((w) => ({
    tag: w.tag,
    address: w.address,
    explorer: EXPLORER(w.address),
    registryStatus: w.registryStatus,
    registryTx: w.registryTx,
    registryBlock: w.registryBlock?.toString(),
    anchorAt: w.anchorAt,
    proofTx: w.proofTx,
    proofAt: w.proofAt,
    provenKey: w.provenKey,
    explorerAt: w.explorerAt,
    ...(w.error ? { error: w.error } : {}),
  }));

  const proven = wallets.filter((w) => w.proofTx).length;
  const shown = wallets.filter((w) => w.explorerAt).length;
  note("");
  note("| wallet | key proven | anchor reached | proof tx | explorer shows Celo |");
  note("|---|---|---|---|---|");
  for (const w of wallets) {
    note(
      `| ${w.tag} | ${w.provenKey ?? "—"} | ${w.anchorAt ?? "—"} | ${w.proofTx ? `[\`${String(w.proofTx).slice(0, 10)}…\`](https://sepolia.celoscan.io/tx/${w.proofTx}) ${w.proofAt ?? ""}` : "—"} | ${w.explorerAt ?? "not shown"} |`,
    );
  }
  note("");
  const pass = shown === wallets.length;
  const sessionKeys = wallets.filter((w) => w.provenKey === "session").length;
  note(pass ? `**PASS** — all ${wallets.length} wallets show a key populated on Celo (${sessionKeys} of them the session key; see the notes for any that mirrored the root key instead).` : `**FAIL** — ${shown}/${wallets.length} show Celo on the explorer (${proven}/${wallets.length} proofs landed).`);
  record.summary = { proven, shown, count: wallets.length };
  record.verdict = pass ? "PASS" : "FAIL";
  console.log(`\n${pass ? "PASS" : "FAIL"}: ${shown}/${wallets.length} shown on the explorer, ${proven}/${wallets.length} proofs landed`);
}

main()
  .catch((err) => {
    record.verdict = "FAIL";
    record.error = err instanceof Error ? err.message : String(err);
    note("");
    note(`**FAIL** — ${record.error}`);
    console.error(`\nFAIL — ${record.error}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const path = new URL(`./mirror-the-five-run-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`run record ${path.pathname.split("/").pop()}`);
  });
