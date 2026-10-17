/**
 * LIVE (Celo Sepolia, via relay-staging) — a session key used on Celo BEFORE
 * its KeyStore registration on Ethereum Sepolia has confirmed.
 *
 * What this has to show, in order:
 *
 *   1. `grantSession` returns with the Celo authorization CONFIRMED and the
 *      Sepolia registry leg still `PENDING`.
 *   2. The session executes a real transaction on Celo while that registration
 *      is still in flight. Its block timestamp is recorded.
 *   3. The Sepolia `KeyRegistered` lands AFTER that execute, which is what
 *      makes "the key was usable before the L1 write" a measurement and not a
 *      claim.
 *   4. The cache proof follows, once the L2 anchors the registry block.
 *
 * Before this change the order was forced the other way: the Celo
 * authorization waited for the Sepolia write, so step 2 could not happen at
 * all (evidence/2026-10-15-demo-grant-did-authorize-on-celo.md).
 *
 * Two shapes, because they prove different halves:
 *
 *   - No CELO_FIRST_WALLET_KEY: a FRESH wallet. Its KeyStore write is a
 *     first-time one (`initialRegisterKey`), which the relay refuses to
 *     prepare for an L2-funded write today, so this shape proves the ordering,
 *     the PENDING leg, and that a FAILED registration leaves the session
 *     working -- but it cannot produce a `KeyRegistered`.
 *   - CELO_FIRST_WALLET_KEY set to an already root-registered wallet: the write
 *     is a single `registerKey`, which does land, so this shape produces the
 *     `KeyRegistered` timestamp and shows it is later than the execute.
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO on Celo Sepolia (>= 1)
 *   CELO_FIRST_WALLET_KEY  optional: an existing wallet's admin key
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *   SEPOLIA_RPC_URL        optional registry-chain read RPC override
 *   ALTANA_RELAY_URL       optional relay override
 *
 * Run: bun run live:celo-first   (from tests/e2e)
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  signerFromPrivateKey,
  waitForBalance,
  type GrantLeg,
  sdkBuild,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseGwei,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
/**
 * Four relayed operations happen on this wallet: the authorization, the
 * registration's source-side intent, the session's execute and the sweep. At
 * the 1,500,000 intent buffer one costs about 0.3 CELO, so 0.6 did not cover
 * them and the later ones came back FAILED with no funds behind them.
 */
const CELO_FUNDING = parseEther("1.5");
/** What the session sends, to prove it can act at all. */
const PROBE = parseEther("0.001");

const l1Read = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
/**
 * One execution network, Celo Sepolia, with its registry chain pointed at the
 * same relay. Sepolia is deliberately NOT in `chains`: it is the registry
 * chain, reached through `registry.l1`, and the write there is paid from the
 * Celo balance.
 */
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

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const t0 = Date.now();
/** Seconds since the grant started, so every line is comparable. */
const at = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

/**
 * A transaction's block timestamp, which is the only clock both chains share.
 *
 * Retried: forno is load balanced, so the node that served the receipt and the
 * node asked for the block need not be the same one, and the second can answer
 * "Block at number N could not be found" for a block the first just named.
 */
async function blockTime(
  client: PublicClient,
  hash: Hex,
): Promise<{ block: bigint; unix: number; iso: string }> {
  let last: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const unix = Number(block.timestamp);
      return { block: receipt.blockNumber, unix, iso: new Date(unix * 1000).toISOString() };
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  throw new Error(`could not read the block of ${hash} after 10 tries: ${(last as Error).message.split("\n")[0]}`);
}

const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString() };

async function main() {
  console.log("LIVE: Celo-first grant, session used before the Sepolia registration");
  console.log("====================================================================\n");

  // Which code this run actually ran. The e2e imports the BUILT package, so a
  // stale `dist/` silently exercises the previous version: one run of this
  // script reported a clean result for a gate that was not in the build
  // (2026-10-07-what-code-a-spine-run-ran.md is the same failure). A run that
  // does not state its own code cannot be used as evidence about that code.
  console.log(`sdk build ${sdkBuild.describe}`);
  record.sdkBuild = sdkBuild.describe;
  if (sdkBuild.dirty) {
    console.log("  (dirty tree: run `bun run --cwd packages/wallet build` if you changed src since)");
  }

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });
  const funderBalance = await pub.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO`);
  assert(funderBalance >= CELO_FUNDING * 2n, `the funder holds at least ${formatEther(CELO_FUNDING * 2n)} CELO`);

  const client = createClient({ chains: [network] });

  // ── The wallet: a fresh one, or an existing already-root-registered one. ──
  const reused = process.env.CELO_FIRST_WALLET_KEY as Hex | undefined;
  const adminKey = reused ?? generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  if (!reused) {
    appendFileSync(
      testnetEnvFile(),
      `\n# live-celo-first-grant wallet ${wallet.address}, ${new Date().toISOString()}\n` +
        `CELOFIRST_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
    );
  }
  console.log(`\nwallet ${wallet.address}${reused ? " (reused, from CELO_FIRST_WALLET_KEY)" : " (fresh; key saved before funding)"}`);
  record.wallet = wallet.address;
  record.walletWasFresh = !reused;

  const rootBefore = await rootKeyCount(wallet.address);
  console.log(`KeyStore keys on Sepolia before the grant: ${rootBefore}` +
    ` (${rootBefore === 0 ? "no root: this will be a first-time write" : "root present: a single registerKey"})`);
  record.keyStoreKeysBefore = rootBefore;

  const before = await pub.getBalance({ address: wallet.address });
  const topUp = CELO_FUNDING > before ? CELO_FUNDING - before : 0n;
  if (topUp > 0n) {
    const fundTx = await fw.sendTransaction({ to: wallet.address, value: topUp, account: funder, chain: celoSepolia });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
    console.log(`funded ${formatEther(topUp)} CELO (to ${formatEther(CELO_FUNDING)})`);
  } else {
    console.log(`already holds ${formatEther(before)} CELO; no top-up`);
  }

  // ── 1. The grant. ──
  console.log("\n[1] grantSession on Celo Sepolia, registry on Ethereum Sepolia");
  const sessionPrivateKey = generatePrivateKey();
  const sessionKey = signerFromPrivateKey(sessionPrivateKey);
  const events: string[] = [];
  const grant = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: sessionKey,
    permissions: {
      calls: [{ to: funder.address }],
      // The session pays the relay's fee out of its OWN native spend cap, and
      // at the 1,500,000 intent buffer that fee is about 0.3 CELO. A cap of
      // 0.05 is therefore not a tight cap, it is an unusable session: every
      // intent fails the account's spend check, and the relay reports it as a
      // bare statusCode 300 with no receipts and no reason.
      spend: [{ limit: parseEther("1"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (status: string, detail?: { chainId?: number; step?: string; reason?: string }) => {
      const line = `${at()} ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}${detail?.reason ? ` — ${detail.reason}` : ""}`;
      events.push(line);
      console.log(`    ${line}`);
    },
  });
  record.statusEvents = events;
  // Saved so a refused execute can be retried later instead of regranting:
  // the key is the only thing that cannot be recovered from chain.
  appendFileSync(
    testnetEnvFile(),
    `\n# live-celo-first-grant SESSION key for wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `CELOFIRST_SESSION_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${sessionPrivateKey}\n`,
  );
  record.grantReturnedAt = at();

  const accountLeg = grant.legs.find((l: GrantLeg) => l.kind === "account" && l.chainId === network.chainId)!;
  const registryLegAtReturn = grant.legs.find((l: GrantLeg) => l.kind === "registry")!;
  console.log(`\n    returned at ${at()}: status=${grant.status}`);
  console.log(`    account  ${accountLeg.status}  ${network.explorer}/tx/${accountLeg.transactionHash}`);
  console.log(`    registry ${registryLegAtReturn.chainId}: ${registryLegAtReturn.status}`);
  assert(grant.status === "granted", `the grant is usable (${grant.status})`);
  assert(accountLeg.status === "CONFIRMED", "the Celo authorization confirmed");
  assert(
    registryLegAtReturn.status === "PENDING",
    "the Sepolia registry leg is still PENDING at return — the grant did not wait for it",
  );
  assert(
    grant.keyHash !== grant.keyId,
    `the result carries the account keyHash (${grant.keyHash.slice(0, 12)}…) as well as the KeyStore keyId (${grant.keyId.slice(0, 12)}…)`,
  );
  const authorization = await blockTime(pub, accountLeg.transactionHash!);
  console.log(`    Celo authorization at ${authorization.iso} (block ${authorization.block})`);
  record.celoAuthorization = { tx: accountLeg.transactionHash, ...authorization, block: String(authorization.block) };

  // Whether the registration is still running at return is a race with the
  // relay-catch-up sleep, not a property of the change, so it is recorded
  // rather than asserted. What matters is that the grant did not WAIT for it,
  // which the PENDING leg above already shows.
  const stillRunning = Symbol("running");
  const peek = await Promise.race([grant.registration, Promise.resolve(stillRunning)]);
  record.registrationStillRunningAtReturn = peek === stillRunning;
  console.log(`    registration still running at return: ${peek === stillRunning}`);

  // ── 2. The session acts, while the registration is in flight. ──
  console.log("\n[2] execute with the SESSION key, registration still in flight");
  const session = grant as unknown as Session;
  // Timed, because the number is the finding either way. Doris's rule is that
  // this call must NOT wait for the registration, so it should be the cost of
  // one intent (about 5s) and never the length of the write. A hold that was
  // tried and removed (option A, 2026-10-17) made it 45.3s, which is why this
  // stays instrumented.
  const calledAt = Date.now();
  console.log(`    ${at()} calling execute`);
  const exec = await executeProbe(client, session, funder.address, grant.keyHash);
  const waited = (Date.now() - calledAt) / 1000;
  console.log(`    execute returned after ${waited.toFixed(1)}s`);
  record.executeCalledAt = `t+${((calledAt - t0) / 1000).toFixed(1)}s`;
  record.executeBlockedSeconds = Number(waited.toFixed(1));
  const nonceErrors = exec.attempts.filter((a) => /InvalidNonce|invalid nonce|nonce/i.test(a));
  record.nonceErrors = nonceErrors;
  assert(nonceErrors.length === 0, `no attempt hit a nonce error (${nonceErrors.length} did)`);
  assert(exec.attempts.length === 1, `it took one attempt, not a retry loop (${exec.attempts.length})`);
  record.sessionExecuteAttempts = exec.attempts;
  assert(exec.status === "CONFIRMED", `the session's transaction confirmed (${exec.status})`);
  const executed = await blockTime(pub, exec.hash);
  console.log(`    ${at()} session tx ${network.explorer}/tx/${exec.hash}`);
  console.log(`    executed at ${executed.iso} (block ${executed.block})`);
  record.sessionExecute = { tx: exec.hash, ...executed, block: String(executed.block) };

  // Read the registry at that moment: this is the claim, checked rather than assumed.
  const registeredYet = await isRegistered(wallet.address, grant.keyId);
  console.log(`    KeyStore.isValidKey at this point: ${registeredYet}`);
  record.registeredAtExecuteTime = registeredYet;

  // ── 3. The registration lands, after the execute. ──
  console.log("\n[3] wait for the Sepolia registration");
  const registryLegs = await grant.registration;
  const sepoliaLeg = registryLegs.find((l: GrantLeg) => l.chainId === SEPOLIA.chainId)!;
  console.log(`    ${at()} registry ${sepoliaLeg.status} ${sepoliaLeg.via ? `via ${sepoliaLeg.via}` : ""}`);
  if (sepoliaLeg.reason) console.log(`    reason: ${sepoliaLeg.reason}`);
  if (sepoliaLeg.rootRegistration) {
    console.log(`    root (initialRegisterKey): ${sepoliaLeg.rootRegistration.status} ${sepoliaLeg.rootRegistration.transactionHash ?? ""}`);
  }
  record.sepoliaRegistryLeg = {
    status: sepoliaLeg.status,
    via: sepoliaLeg.via,
    tx: sepoliaLeg.transactionHash,
    block: sepoliaLeg.blockNumber === undefined ? undefined : String(sepoliaLeg.blockNumber),
    fundedFromChainId: sepoliaLeg.fundedFromChainId,
    sourceTransactionHash: sepoliaLeg.sourceTransactionHash,
    reason: sepoliaLeg.reason,
    rootRegistration: sepoliaLeg.rootRegistration
      ? { ...sepoliaLeg.rootRegistration, blockNumber: sepoliaLeg.rootRegistration.blockNumber === undefined ? undefined : String(sepoliaLeg.rootRegistration.blockNumber) }
      : undefined,
  };
  if (sepoliaLeg.status !== "CONFIRMED") {
    // The SDK-side claims are all proven by now. This is the relay refusing an
    // L2-funded first-time write, which is Doris's call on the relay and must
    // not be worked around here (briefs/sdk.md).
    console.log("\n====================================================================");
    console.log("Result: PARTIAL — the ordering is proven and the session worked;");
    console.log("the KeyStore registration did not confirm, so there is no");
    console.log("KeyRegistered timestamp to compare. Reason, verbatim:\n");
    console.log(sepoliaLeg.reason);
    record.verdict = "PARTIAL: ordering proven, registration refused by the relay";
    await sweep(wallet.address, adminKey, funder.address);
    writeFileSync(runFile(), `${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  const registered = await blockTime(sep, sepoliaLeg.transactionHash!);
  console.log(`    Sepolia KeyRegistered at ${registered.iso} (block ${registered.block})`);
  record.sepoliaRegistration = { tx: sepoliaLeg.transactionHash, ...registered, block: String(registered.block) };
  // Which of the two landed first is a race with the relay, not a property of
  // the change, so it is reported rather than asserted. On a wallet whose root
  // is already registered the Sepolia write is a single intent and takes about
  // 13s -- quicker than this SDK's own 12s relay-catch-up sleep, so the write
  // can well land before an execute that only starts once grantSession has
  // returned. What the change guarantees is that the AUTHORIZATION never waited
  // for it, which the PENDING leg at return already showed.
  // Two different reasons the registration can land first, and naming the
  // wrong one is worse than naming none: either the write was quick (a single
  // `registerKey` on an already-rooted wallet takes about 13s, less than this
  // SDK's own catch-up sleep), or the execute was HELD until the write
  // finished, which is what `executeBlockedSeconds` distinguishes.
  const blocked = record.executeBlockedSeconds as number;
  const order =
    registered.unix > executed.unix
      ? `the registration landed AFTER the execute, +${registered.unix - executed.unix}s`
      : `the registration landed ${executed.unix - registered.unix}s BEFORE the execute, ` +
        (blocked >= 10
          ? `because the execute was held ${blocked}s waiting for it (the pending-intent hold)`
          : `because the write was quick; the execute was not held (${blocked}s)`);
  console.log(`    ${order}`);
  record.order = order;
  assert(await isRegistered(wallet.address, grant.keyId), "and the key is valid in the KeyStore now");

  // ── 4. The cache proof, which needed the write's block. ──
  console.log("\n[4] cache proof into the Celo KeyStoreCache");
  const caches = await grant.cacheSync;
  const cache = caches.find((l: GrantLeg) => l.chainId === network.chainId);
  console.log(`    ${at()} cache ${cache?.status}${cache?.reason ? ` — ${cache.reason}` : ""}`);
  if (cache?.transactionHash) console.log(`    ${network.explorer}/tx/${cache.transactionHash}`);
  record.cacheLeg = {
    status: cache?.status,
    tx: cache?.transactionHash,
    l1BlockNumber: cache?.l1BlockNumber === undefined ? undefined : String(cache.l1BlockNumber),
    reason: cache?.reason,
  };

  const usable = executed.unix - authorization.unix;
  const l1Wait = registered.unix - authorization.unix;
  console.log(`\n    session usable ${usable}s after the Celo authorization confirmed`);
  console.log(`    the Sepolia registration took ${l1Wait}s from that point`);
  record.secondsAuthorizationToExecute = usable;
  record.secondsAuthorizationToRegistration = l1Wait;

  await sweep(wallet.address, adminKey, funder.address);

  // Read off the run rather than asserted: whether the execute beat the
  // registration depends on how fast the relay was, and a fixed verdict string
  // said "acted before its registration" for a run where it demonstrably did
  // not (the 2026-10-17 hold run).
  record.verdict =
    `PASS: the session executed ${blocked}s after the call, ` +
    (registered.unix > executed.unix
      ? `before its Sepolia registration confirmed`
      : `and its Sepolia registration had already confirmed ${executed.unix - registered.unix}s earlier`);
  writeFileSync(runFile(), `${JSON.stringify(record, null, 2)}\n`);
  console.log("\n====================================================================");
  console.log(`Result: ${record.verdict}`);
}

/**
 * The session's transaction. The registration is paid by an intent from this
 * same account on Celo, and the relay reserves no nonce for an intent it has
 * not mined (2026-09-28-back-to-back-race-attribution.md), so an execute that
 * overlaps it can come back with a nonce error. Retried, and every attempt is
 * recorded: a collision here is a finding, not something to hide.
 */
async function executeProbe(
  client: ReturnType<typeof createClient>,
  session: Session,
  to: Address,
  keyHash: Hex,
): Promise<{ status: string; hash: Hex; attempts: string[] }> {
  const attempts: string[] = [];
  for (let i = 1; i <= 10; i++) {
    // Three views of the same question, so a failure says which layer disagrees:
    //   ours   - this process's Celo RPC, reading the account directly
    //   relay  - the relay's OWN wallet_getKeys, which goes through the same
    //            get_keys_for_chain that prepareCalls uses to find the key
    //   execute- prepareCalls itself
    const [ours, theirs] = await Promise.all([
      ourViewHasKey(session.walletAddress, keyHash).catch((e) => `read failed: ${(e as Error).message.split("\n")[0]}`),
      relayViewHasKey(session.walletAddress, keyHash),
    ]);
    const views = `ours=${ours} relay=${theirs}`;
    try {
      const r = await client.execute({ session, chainId: 11142220, calls: { to, value: PROBE, data: "0x" } });
      const detail = `${r.status}${r.statusCode !== undefined ? ` code ${r.statusCode}` : ""} bundle ${r.callsId}${r.transactionHash ? ` tx ${r.transactionHash}` : " (no tx)"}`;
      attempts.push(`${at()} attempt ${i} (${views}): ${detail}`);
      console.log(`    ${at()} attempt ${i} (${views}): ${detail}`);
      if (r.status === "CONFIRMED") return { status: r.status, hash: r.transactionHash as Hex, attempts };
      // A status alone names nothing. Ask the relay what it did with the bundle.
      const bundle = await relayCallsStatus(r.callsId);
      attempts.push(`      relay bundle: ${bundle}`);
      console.log(`      relay bundle: ${bundle}`);
    } catch (err) {
      const msg = (err as Error).message.split("\n")[0]!;
      attempts.push(`${at()} attempt ${i} (${views}) threw: ${msg}`);
      console.log(`    ${at()} attempt ${i} (${views}) threw: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  return { status: "FAILED", hash: "0x" as Hex, attempts };
}

/**
 * Whether THIS process's Celo RPC sees the key on the account.
 *
 * The account's `getKeys()` returns a TUPLE, `(Key[], bytes32[])`. Declaring it
 * as one `bytes32[]` makes the read throw, which a `catch` turns into a
 * confident "false" — it reported the key missing for five minutes while it was
 * on chain the whole time.
 */
async function ourViewHasKey(wallet: Address, keyHash: Hex): Promise<boolean> {
  const hashes = (await pub.readContract({
    address: wallet,
    abi: [
      {
        name: "getKeys",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { type: "tuple[]", components: [
            { name: "expiry", type: "uint40" },
            { name: "keyType", type: "uint8" },
            { name: "isSuperAdmin", type: "bool" },
            { name: "publicKey", type: "bytes" },
          ] },
          { type: "bytes32[]" },
        ],
      },
    ] as const,
    functionName: "getKeys",
  })) as readonly [unknown, readonly Hex[]];
  return hashes[1].map((h) => h.toLowerCase()).includes(keyHash.toLowerCase());
}

/**
 * Whether the RELAY says the key is on the account, asked through its own
 * `wallet_getKeys`. That call and `wallet_prepareCalls` both resolve the key
 * with `get_keys_for_chain`, so if this says yes while prepareCalls says the
 * key hash is unknown, the disagreement is inside the relay.
 */
async function relayViewHasKey(wallet: Address, keyHash: Hex): Promise<string> {
  try {
    const res = await fetch(RELAY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "wallet_getKeys",
        params: [{ address: wallet, chainId: 11142220 }],
      }),
    });
    const body: any = await res.json();
    const keys = body?.result?.["0xaa044c"] ?? [];
    return String(keys.some((k: any) => String(k.hash).toLowerCase() === keyHash.toLowerCase()));
  } catch (e) {
    return `ask failed: ${(e as Error).message}`;
  }
}

/** The relay's own account of a bundle, so a FAILED status says what failed. */
async function relayCallsStatus(callsId: Hex): Promise<string> {
  try {
    const res = await fetch(RELAY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getCallsStatus", params: [callsId] }),
    });
    const body: any = await res.json();
    return JSON.stringify(body?.result ?? body?.error ?? body).slice(0, 900);
  } catch (e) {
    return `ask failed: ${(e as Error).message}`;
  }
}

/** Where this run's JSON goes: one file per shape, so neither overwrites the other. */
function runFile(): URL {
  // Dated and stamped: three runs of this script overwrote each other's record
  // in a single afternoon, and an evidence file ended up pointing at a run it
  // was not describing.
  const shape = record.walletWasFresh ? "fresh" : "rootregistered";
  const day = new Date().toISOString().slice(0, 10);
  const build = String(record.sdkBuild ?? "nostamp").replace(/[^a-zA-Z0-9]/g, "");
  return new URL(`./celo-first-grant-run-${shape}-${day}-${build}.json`, import.meta.url);
}

const GETKEYS_ABI = [
  { name: "getKeys", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32[]" }] },
] as const;

/** How many keys the Sepolia KeyStore holds for this wallet: 0 means no root. */
async function rootKeyCount(wallet: Address): Promise<number> {
  try {
    const keys = (await sep.readContract({
      address: SEPOLIA.keyStore,
      abi: GETKEYS_ABI,
      functionName: "getKeys",
      args: [wallet],
    })) as readonly Hex[];
    return keys.length;
  } catch {
    return -1;
  }
}

const KEYSTORE_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

function isRegistered(wallet: Address, keyId: Hex): Promise<boolean> {
  return sep.readContract({
    address: SEPOLIA.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [wallet, keyId],
  }).catch(() => false) as Promise<boolean>;
}

/**
 * Returns what is left to the funder. Best effort, logged, never throws.
 *
 * A plain EOA transfer, not a relayed intent: the relay's fee at the 1,500,000
 * buffer is about 0.3 CELO, which can exceed what is left after the run, and a
 * relayed sweep then fails with "quote has asset deficits" and strands the
 * balance. 21,000 gas costs about 0.0015. The wallet is a delegated EOA, so it
 * can still send an ordinary transaction signed by the admin key.
 */
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
    const value = bal - cost;
    const w = createWalletClient({ account, chain: celoSepolia, transport: http(network.publicRpcUrl) });
    const hash = await w.sendTransaction({ to: funder, value, gas: 21_000n, gasPrice });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(value)} CELO  ${hash}`);
    record.swept = { value: formatEther(value), tx: hash };
  } catch (e) {
    console.log(`    CELO sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  try {
    writeFileSync(runFile(), `${JSON.stringify({ ...record, failure: String(e) }, null, 2)}\n`);
  } catch {}
  process.exit(1);
});
