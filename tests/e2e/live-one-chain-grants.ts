/**
 * Live proof that a grant goes to one chain, on a client that has two.
 *
 * The client is created with BNB testnet and Celo Sepolia, both served by the
 * Altana testnet relay. Every step is written the way a 0.9.0 integration
 * writes it (`chainId`, `transactionHash`, a throw on failure), and after
 * each one the OTHER chain is read to show nothing happened there.
 *
 *   BNB testnet (wallet A, tBNB only)
 *     1. grantSession({ chainId: 97 }): transactionHash; key on the account
 *        and valid in the KeyStore; nothing on Celo Sepolia or Sepolia.
 *        Session execute. revokeSession({ chainId: 97 }): transactionHash,
 *        key gone.
 *     2. grantSession with no chain option: lands on the default chain only.
 *     4. Forced failures: a grant from an unfunded wallet throws; a revoke
 *        that fails on the named chain throws SessionRevokeError.
 *   Celo Sepolia (wallet C, CELO only, no Sepolia ETH)
 *     3. grantSession({ chainId: 11142220 }): returns when Celo confirms;
 *        the session executes at once; `registration` and `cacheSync` are
 *        awaited and timed; nothing on BNB testnet. Revoke with its proof.
 *     5. chainIds: [97, 11142220] grants on both and does not throw.
 *
 * Throwaway keys are saved to the shared testnet env before any funding, and
 * what is left goes back to the funder at the end, pass or fail.
 *
 * Needs TEST_FUNDER_KEY funded with tBNB on BNB testnet and CELO on Celo
 * Sepolia. Optional: CELO_SEPOLIA_RPC_URL, SEPOLIA_RPC_URL, BNB_TESTNET_RPC_URL,
 * ONLY=bnb|celo to run one half, ONE_CHAIN_OUT=<file> for the JSON record.
 *
 * The KeyStore write on Sepolia is paid from the wallet's balance on Celo
 * Sepolia at the relay's exchange rate, and at that rate it can cost far more
 * CELO than a testnet funder holds (about 29 CELO for a first write on
 * 2026-11-13). ONE_CHAIN_CELO_USDC=<amount> also sends the wallet that much
 * USDC on Celo Sepolia, which the relay accepts for the same write. Without
 * it the run still proves the grant, and reports the registration as failed.
 *
 * Run: bun run live:one-chain   (from tests/e2e, shared testnet env loaded)
 */
import {
  BNB_TESTNET,
  CELO_SEPOLIA,
  SEPOLIA,
  SessionRevokeError,
  TESTNET_RELAY_URL,
  createClient,
  getKeys,
  keyStoreCacheOf,
  readCachedKey,
  signerFromPrivateKey,
  type GrantSessionResult,
  type NetworkConfig,
  type SessionLeg,
} from "@altananetwork/sdk";
import { appendFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describeLeg, legOf } from "./session-legs.js";
import { testnetEnvFile } from "./testnet-env.js";

const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!FUNDER_KEY) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");

const rpc = (n: NetworkConfig, url?: string): NetworkConfig => (url ? { ...n, publicRpcUrl: url } : n);
const sepolia = rpc(SEPOLIA, process.env.SEPOLIA_RPC_URL);
const bnb = rpc(BNB_TESTNET, process.env.BNB_TESTNET_RPC_URL);
const celo: NetworkConfig = {
  ...rpc(CELO_SEPOLIA, process.env.CELO_SEPOLIA_RPC_URL),
  registry: { kind: "cached", l1: sepolia, keyStoreCache: keyStoreCacheOf(CELO_SEPOLIA) },
};
for (const n of [bnb, celo]) {
  if (n.relayUrl !== TESTNET_RELAY_URL) throw new Error(`${n.chain.name} is not on the testnet relay`);
}

const BNB_FUNDING = parseEther(process.env.ONE_CHAIN_BNB_FUNDING ?? "0.006");
const BNB_FUNDING_BOTH = parseEther("0.004");
const CELO_FUNDING = parseEther(process.env.ONE_CHAIN_CELO_FUNDING ?? "1.5");
const CELO_USDC = process.env.ONE_CHAIN_CELO_USDC;
const ONLY = process.env.ONLY;

const pubOf = (n: NetworkConfig): PublicClient =>
  createPublicClient({ chain: n.chain, transport: http(n.publicRpcUrl) }) as PublicClient;
const pub = { bnb: pubOf(bnb), celo: pubOf(celo), sepolia: pubOf(sepolia) };

const KEYSTORE_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const started = performance.now();
const at = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
const since = (t: number) => Number(((performance.now() - t) / 1000).toFixed(1));
const tx = (n: NetworkConfig, hash?: Hex) => (hash ? `${n.explorer}/tx/${hash}` : "(no hash)");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Error text with any RPC URL that is not public removed: provider URLs carry keys. */
function safe(text: string): string {
  return text.replace(/https?:\/\/[^\s"')]+/g, (url) =>
    /altana\.network|publicnode\.com|celo-testnet\.org|bscscan\.com|celoscan\.io|etherscan\.io|0xrpc\.io/.test(url) ? url : "<rpc>",
  );
}

const record: Record<string, unknown> = { startedAt: new Date().toISOString(), relay: TESTNET_RELAY_URL };
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

const isValidKey = (client: PublicClient, n: NetworkConfig, wallet: Address, keyId: Hex) =>
  client.readContract({ address: n.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [wallet, keyId] });

/** The key hashes the account holds, or null when the address has no account code. */
async function accountKeyHashes(client: PublicClient, wallet: Address): Promise<readonly Hex[] | null> {
  const code = await client.getCode({ address: wallet });
  if (!code || code === "0x") return null;
  return (await getKeys(client, wallet)).keyHashes;
}

/** Polls a read until it holds: public RPCs can trail the relay by a few seconds. */
async function eventually(read: () => Promise<boolean>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await read()) return true;
    } catch {
      // A read that fails is retried like one that is not true yet.
    }
    if (Date.now() >= deadline) return false;
    await sleep(3_000);
  }
}

/** What a chain shows for a wallet nothing was ever done to. */
async function untouched(
  label: string,
  client: PublicClient,
  wallet: Address,
  keyStore: { network: NetworkConfig; client: PublicClient; keyIds: readonly Hex[] },
): Promise<Record<string, unknown>> {
  const [code, nonce] = await Promise.all([
    client.getCode({ address: wallet }),
    client.getTransactionCount({ address: wallet }),
  ]);
  const valid = await Promise.all(keyStore.keyIds.map((id) => isValidKey(keyStore.client, keyStore.network, wallet, id)));
  check(!code || code === "0x", `${label}: the address has no account code`);
  check(nonce === 0, `${label}: nonce is 0 (${nonce})`);
  check(valid.every((v) => v === false), `${label}: KeyStore on ${keyStore.network.chain.name} lists none of the keys`);
  return { code: code ?? "0x", nonce, keyStoreValid: valid };
}

/** A fresh admin key, saved to the shared env before the wallet is sent anything. */
function throwawayKey(tag: string): Hex {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  appendFileSync(
    testnetEnvFile(),
    `\n# live-one-chain-grants ${tag} wallet ${address}, ${new Date().toISOString()}\n` +
      `ONECHAIN_${address.slice(2, 10).toUpperCase()}_KEY=${key}\n`,
  );
  return key;
}

async function fund(n: NetworkConfig, client: PublicClient, to: Address, value: bigint): Promise<void> {
  const funder = privateKeyToAccount(FUNDER_KEY);
  const w = createWalletClient({ account: funder, chain: n.chain, transport: http(n.publicRpcUrl) });
  const hash = await w.sendTransaction({ to, value });
  await client.waitForTransactionReceipt({ hash });
  await eventually(async () => (await client.getBalance({ address: to })) >= value, 120_000);
  console.log(`    funded ${formatEther(value)} ${n.chain.nativeCurrency.symbol} on ${n.chain.name}`);
}

/** Everything a thrown value says about itself, cause chain included. */
function describeThrown(err: unknown): Record<string, unknown> {
  const chain: string[] = [];
  let cur: unknown = (err as { cause?: unknown })?.cause;
  for (let depth = 0; cur && depth < 8; depth++) {
    chain.push(`${(cur as Error)?.name ?? typeof cur}: ${safe(String((cur as Error)?.message ?? cur)).split("\n")[0]}`);
    cur = (cur as { cause?: unknown })?.cause;
  }
  return {
    name: (err as Error)?.name,
    class: (err as object)?.constructor?.name,
    message: safe(String((err as Error)?.message ?? err)),
    hasCause: (err as { cause?: unknown })?.cause !== undefined,
    causeChain: chain,
  };
}

async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (err) {
    return err;
  }
  return undefined;
}

const legLines = (legs: readonly SessionLeg[]) => legs.map(describeLeg);
const chainsOf = (legs: readonly SessionLeg[]) => [...new Set(legs.map((l) => l.chainId))].sort((a, b) => a - b);

/** Wallets to empty at the end, with the chains they may hold funds on. */
const toSweep: { key: Hex; networks: { n: NetworkConfig; client: PublicClient; tokens?: Address[] }[] }[] = [];

async function bnbHalf(client: ReturnType<typeof createClient>, funder: Address): Promise<void> {
  const out: Record<string, unknown> = {};
  record.bnb = out;
  const adminKey = throwawayKey("A (BNB testnet)");
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  toSweep.push({ key: adminKey, networks: [{ n: bnb, client: pub.bnb }] });
  out.wallet = wallet.address;
  console.log(`\nwallet A ${wallet.address} (tBNB only)`);
  await fund(bnb, pub.bnb, wallet.address, BNB_FUNDING);

  const permissions = {
    calls: [{ to: funder }],
    // The cap also pays the relay fee, so it is not a tight one.
    spend: [{ limit: parseEther("0.002"), period: "day" as const }],
  };
  const expiry = () => Math.floor(Date.now() / 1000) + 3600;

  // ── 1. The 0.9.0 call: one chain, named. ──
  console.log("\n[1] grantSession({ wallet, signer, permissions, chainId: 97 })");
  let t = performance.now();
  const s1 = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: signerFromPrivateKey(generatePrivateKey()),
    permissions,
    expiry: expiry(),
    chainId: 97,
  });
  const grant1 = { seconds: since(t), status: s1.status, transactionHash: s1.transactionHash, legs: legLines(s1.legs) };
  out.grant = { ...grant1, explorer: tx(bnb, s1.transactionHash), keyId: s1.keyId, keyHash: s1.keyHash };
  console.log(`    returned in ${grant1.seconds}s: ${s1.status}  ${tx(bnb, s1.transactionHash)}`);
  for (const l of grant1.legs) console.log(`      ${l}`);
  check(typeof s1.transactionHash === "string", "the result carries transactionHash");
  check(s1.transactionHash === legOf(s1.legs, "account", 97).transactionHash, "it is the account leg's transaction");
  check(chainsOf(s1.legs).join() === "97", `every leg is on chain 97 (${chainsOf(s1.legs).join(", ")})`);
  check(
    await eventually(async () => (await accountKeyHashes(pub.bnb, wallet.address))?.includes(s1.keyHash) === true),
    "BNB testnet: the account holds the key (getKeys lists its keyHash)",
  );
  check(
    await eventually(() => isValidKey(pub.bnb, bnb, wallet.address, s1.keyId)),
    "BNB testnet: the KeyStore lists the key as valid",
  );
  out.celoAfterGrant = await untouched("Celo Sepolia", pub.celo, wallet.address, {
    network: sepolia,
    client: pub.sepolia,
    keyIds: [s1.keyId],
  });
  out.sepoliaAfterGrant = await untouched("Sepolia", pub.sepolia, wallet.address, {
    network: sepolia,
    client: pub.sepolia,
    keyIds: [s1.keyId],
  });
  const cached = await readCachedKey(pub.celo, keyStoreCacheOf(celo), wallet.address, s1.keyId);
  check(cached.publicKey === "0x", "Celo Sepolia: the KeyStoreCache has no entry for the key");

  console.log("\n[1b] execute with the session on BNB testnet");
  t = performance.now();
  const exec = await client.execute({ session: s1, calls: { to: funder, value: 1n, data: "0x" }, chainId: 97 });
  out.execute = { seconds: since(t), status: exec.status, transactionHash: exec.transactionHash, explorer: tx(bnb, exec.transactionHash) };
  console.log(`    ${exec.status} in ${since(t)}s  ${tx(bnb, exec.transactionHash)}`);
  check(exec.status === "CONFIRMED", "the session's transaction confirmed");

  console.log("\n[1c] revokeSession({ wallet, signer, session, chainId: 97 })");
  t = performance.now();
  const r1 = await client.revokeSession({ wallet, signer: admin, session: s1, chainId: 97 });
  out.revoke = {
    seconds: since(t),
    status: r1.status,
    transactionHash: r1.transactionHash,
    explorer: tx(bnb, r1.transactionHash),
    statusCode: r1.statusCode,
    legs: legLines(r1.legs),
  };
  console.log(`    returned in ${since(t)}s: ${r1.status}  ${tx(bnb, r1.transactionHash)}`);
  for (const l of legLines(r1.legs)) console.log(`      ${l}`);
  check(typeof r1.transactionHash === "string", "the result carries transactionHash");
  check(r1.status === "revoked", `status is revoked (${r1.status})`);
  check(
    await eventually(async () => (await accountKeyHashes(pub.bnb, wallet.address))?.includes(s1.keyHash) === false),
    "BNB testnet: the account no longer holds the key",
  );
  check(
    await eventually(async () => !(await isValidKey(pub.bnb, bnb, wallet.address, s1.keyId))),
    "BNB testnet: the KeyStore no longer lists the key as valid",
  );
  const afterRevoke = await thrownBy(async () => {
    const res = await client.execute({ session: s1, calls: { to: funder, value: 1n, data: "0x" }, chainId: 97 });
    if (res.status === "CONFIRMED") throw new Error("UNEXPECTED: the revoked session still executes");
  });
  check(
    !(afterRevoke instanceof Error && afterRevoke.message.startsWith("UNEXPECTED")),
    "the revoked session can no longer execute",
  );

  // ── 2. No chain option: the default chain. ──
  console.log(`\n[2] grantSession with neither chainId nor chainIds (default chain ${client.defaultChainId})`);
  t = performance.now();
  const s2 = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner: signerFromPrivateKey(generatePrivateKey()),
    permissions,
    expiry: expiry(),
  });
  out.defaultGrant = {
    seconds: since(t),
    status: s2.status,
    transactionHash: s2.transactionHash,
    explorer: tx(bnb, s2.transactionHash),
    legs: legLines(s2.legs),
  };
  console.log(`    returned in ${since(t)}s: ${s2.status}  ${tx(bnb, s2.transactionHash)}`);
  for (const l of legLines(s2.legs)) console.log(`      ${l}`);
  check(client.defaultChainId === 97, "the client's default chain is BNB testnet");
  check(chainsOf(s2.legs).join() === "97", `every leg is on the default chain (${chainsOf(s2.legs).join(", ")})`);
  check(typeof s2.transactionHash === "string", "the result carries transactionHash");
  check(
    await eventually(async () => (await accountKeyHashes(pub.bnb, wallet.address))?.includes(s2.keyHash) === true),
    "BNB testnet: the account holds the key",
  );
  out.celoAfterDefaultGrant = await untouched("Celo Sepolia", pub.celo, wallet.address, {
    network: sepolia,
    client: pub.sepolia,
    keyIds: [s1.keyId, s2.keyId],
  });

  // ── 4b. A revoke that fails on the named chain. ──
  // A fee token the relay does not accept: the account leg on BNB testnet
  // fails before anything is sent, and the key stays where it is.
  console.log("\n[4b] revokeSession that fails on chain 97 (a fee token the relay does not accept)");
  const badToken = "0x000000000000000000000000000000000000dEaD" as Address;
  const revokeErr = await thrownBy(() =>
    client.revokeSession({ wallet, signer: admin, session: s2, chainId: 97, feeToken: badToken }),
  );
  const revokeThrown = describeThrown(revokeErr);
  out.failedRevoke = {
    ...revokeThrown,
    isSessionRevokeError: revokeErr instanceof SessionRevokeError,
    legs: revokeErr instanceof SessionRevokeError ? legLines(revokeErr.result.legs) : undefined,
    resultStatus: revokeErr instanceof SessionRevokeError ? revokeErr.result.status : undefined,
  };
  console.log(`    threw ${revokeThrown.class}: ${String(revokeThrown.message).split("\n")[0]}`);
  console.log(`    cause: ${revokeThrown.hasCause ? (revokeThrown.causeChain as string[]).join(" <- ") : "none"}`);
  check(revokeErr instanceof SessionRevokeError, "it throws SessionRevokeError");
  check(revokeErr instanceof SessionRevokeError && revokeErr.chainId === 97, "the error names chain 97");
  check((await accountKeyHashes(pub.bnb, wallet.address))?.includes(s2.keyHash) === true, "the key is still on the account");

  console.log("\n[2b] revokeSession with no chainId (answers for the default chain)");
  t = performance.now();
  const r2 = await client.revokeSession({ wallet, signer: admin, session: s2.publicKey });
  out.defaultRevoke = {
    seconds: since(t),
    status: r2.status,
    transactionHash: r2.transactionHash,
    explorer: tx(bnb, r2.transactionHash),
    legs: legLines(r2.legs),
  };
  console.log(`    returned in ${since(t)}s: ${r2.status}  ${tx(bnb, r2.transactionHash)}`);
  for (const l of legLines(r2.legs)) console.log(`      ${l}`);
  check(typeof r2.transactionHash === "string", "the result carries transactionHash");
  check(
    await eventually(async () => (await accountKeyHashes(pub.bnb, wallet.address))?.includes(s2.keyHash) === false),
    "BNB testnet: the account no longer holds the key",
  );

  // ── 4a. A grant that cannot confirm. ──
  console.log("\n[4a] grantSession from a wallet that holds nothing");
  const emptyAdmin = signerFromPrivateKey(generatePrivateKey());
  const emptyWallet = await client.createWallet({ signer: emptyAdmin });
  const failed: Record<string, unknown> = {};
  out.failedGrants = failed;
  for (const n of [bnb, celo]) {
    const sessionSigner = signerFromPrivateKey(generatePrivateKey());
    const err = await thrownBy(() =>
      client.grantSession({ wallet: emptyWallet, signer: emptyAdmin, sessionSigner, permissions, expiry: expiry(), chainId: n.chainId }),
    );
    const thrown = describeThrown(err);
    failed[n.chainId] = thrown;
    console.log(`    chain ${n.chainId} threw ${thrown.class}:`);
    for (const line of String(thrown.message).split("\n")) console.log(`      | ${line}`);
    console.log(`      cause: ${thrown.hasCause ? (thrown.causeChain as string[]).join(" <- ") : "none"}`);
    check(err !== undefined, `chain ${n.chainId}: the grant throws`);
    const code = await pubOf(n).getCode({ address: emptyWallet.address });
    check(!code || code === "0x", `chain ${n.chainId}: nothing reached the chain`);
  }
}

async function celoHalf(client: ReturnType<typeof createClient>, funder: Address): Promise<void> {
  const out: Record<string, unknown> = {};
  record.celo = out;
  const adminKey = throwawayKey("C (Celo Sepolia)");
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  const usdc = CELO_USDC
    ? (await client.feeCurrencies({ chainId: celo.chainId })).currencies.find((c) => c.symbol === "USDC")
    : undefined;
  if (CELO_USDC && !usdc) throw new Error("the relay lists no USDC on Celo Sepolia");
  toSweep.push({
    key: adminKey,
    networks: [{ n: celo, client: pub.celo, ...(usdc ? { tokens: [usdc.address] } : {}) }, { n: bnb, client: pub.bnb }],
  });
  out.wallet = wallet.address;
  console.log(`\nwallet C ${wallet.address} (${usdc ? "CELO and USDC on Celo Sepolia" : "CELO only"}, nothing on Sepolia)`);
  if (usdc) {
    const amount = parseUnits(CELO_USDC!, usdc.decimals);
    const funderAccount = privateKeyToAccount(FUNDER_KEY);
    const w = createWalletClient({ account: funderAccount, chain: celo.chain, transport: http(celo.publicRpcUrl) });
    const hash = await w.writeContract({ address: usdc.address, abi: erc20Abi, functionName: "transfer", args: [wallet.address, amount] });
    await pub.celo.waitForTransactionReceipt({ hash });
    await eventually(async () => (await pub.celo.readContract({ address: usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] })) >= amount);
    console.log(`    funded ${CELO_USDC} USDC on ${celo.chain.name}`);
    out.usdcFunding = CELO_USDC;
  }

  const permissions = {
    calls: [{ to: funder }],
    // The session pays the relay fee from this cap; about 0.3 CELO an intent.
    spend: [{ limit: parseEther("1"), period: "day" as const }],
  };
  const expiry = () => Math.floor(Date.now() / 1000) + 3 * 3600;
  const sessionSigner = signerFromPrivateKey(generatePrivateKey());

  await fund(celo, pub.celo, wallet.address, CELO_FUNDING);
  check((await pub.sepolia.getBalance({ address: wallet.address })) === 0n, "the wallet holds no ETH on Sepolia");

  // What the grant will take from the wallet. The Sepolia write is paid from
  // CELO at a rate that moves with Sepolia's gas price, so the funding follows
  // the quote instead of trusting a constant.
  console.log("\n[3a] quoteGrantSession({ chainId: 11142220 })");
  try {
    const quote = await client.quoteGrantSession({ wallet, signer: admin, sessionSigner, permissions, expiry: expiry(), chainId: 11142220 });
    out.quote = {
      complete: quote.complete,
      chains: [...new Set(quote.lines.map((l) => l.chainId))],
      balances: quote.balances.map((b) => `${b.chainId} ${b.symbol}: needs ${formatUnits(b.needed, b.decimals)}, holds ${formatUnits(b.balance, b.decimals)}`),
      lines: quote.lines.map((l) => `${l.chainId} ${l.kind}: fee ${l.fee ?? "?"} ${l.reason ? `(${safe(l.reason).split("\n")[0]})` : ""}`),
    };
    for (const line of (out.quote as { balances: string[] }).balances) console.log(`    ${line}`);
    for (const line of (out.quote as { lines: string[] }).lines) console.log(`    ${line}`);
    check(!quote.lines.some((l) => l.chainId === 97), "the quote has no line on BNB testnet");
    const native = quote.balances
      .filter((b) => b.chainId === celo.chainId && /^0x0+$/.test(b.token))
      .reduce((sum, b) => sum + b.needed, 0n);
    // The grant, then an execute, a revoke and two proofs on top of it.
    const want = (native * 13n) / 10n + parseEther("1");
    const held = await pub.celo.getBalance({ address: wallet.address });
    if (want > held && !usdc) {
      const topUp = want - held;
      const funderHolds = await pub.celo.getBalance({ address: funder });
      if (funderHolds < topUp + parseEther("0.3")) {
        throw new Error(`the quote needs ${formatEther(want)} CELO in the wallet and the funder holds ${formatEther(funderHolds)}`);
      }
      console.log(`    the quote needs ${formatEther(native)} CELO; topping the wallet up to ${formatEther(want)}`);
      await fund(celo, pub.celo, wallet.address, topUp);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("the quote needs")) throw err;
    out.quote = { error: safe(String((err as Error).message)).split("\n")[0] };
    console.log(`    quote failed: ${(out.quote as { error: string }).error}`);
  }

  // ── 3. One chain, a cached-registry one. ──
  console.log("\n[3] grantSession({ ..., chainId: 11142220 })");
  const events: string[] = [];
  const t0 = performance.now();
  const s3 = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner,
    permissions,
    expiry: expiry(),
    chainId: 11142220,
    onStatus: (status, detail) => {
      const line = `${since(t0)}s ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}${detail?.reason ? `: ${safe(detail.reason).split("\n")[0]}` : ""}`;
      events.push(line);
      console.log(`      ${line}`);
    },
  });
  const returnedAfter = since(t0);
  console.log(`    returned in ${returnedAfter}s: ${s3.status}  ${tx(celo, s3.transactionHash)}`);
  for (const l of legLines(s3.legs)) console.log(`      ${l}`);
  out.grant = {
    returnedAfterSeconds: returnedAfter,
    status: s3.status,
    transactionHash: s3.transactionHash,
    explorer: tx(celo, s3.transactionHash),
    legsAtReturn: legLines(s3.legs),
    keyId: s3.keyId,
    keyHash: s3.keyHash,
  };
  check(typeof s3.transactionHash === "string", "the result carries transactionHash");
  check(legOf(s3.legs, "account", 11142220).status === "CONFIRMED", "the Celo Sepolia authorization confirmed");
  check(!s3.legs.some((l) => l.chainId === 97), "no leg on BNB testnet");

  console.log("\n[3b] execute with the session, straight away");
  let t = performance.now();
  const exec = await client.execute({ session: s3, calls: { to: funder, value: 1n, data: "0x" }, chainId: 11142220 });
  out.execute = { seconds: since(t), afterGrantStartSeconds: since(t0), status: exec.status, transactionHash: exec.transactionHash, explorer: tx(celo, exec.transactionHash) };
  console.log(`    ${exec.status} in ${since(t)}s  ${tx(celo, exec.transactionHash)}`);
  check(exec.status === "CONFIRMED", "the session's transaction confirmed before the registration finished");

  out.bnbAfterGrant = await untouched("BNB testnet", pub.bnb, wallet.address, {
    network: bnb,
    client: pub.bnb,
    keyIds: [s3.keyId],
  });

  console.log("\n[3c] await registration (the KeyStore write on Sepolia)");
  const registration = await s3.registration;
  const registrationAfter = since(t0);
  console.log(`    resolved ${registrationAfter}s after the grant started`);
  for (const l of legLines(registration)) console.log(`      ${l}`);
  out.registration = {
    secondsAfterGrantStart: registrationAfter,
    legs: legLines(registration),
    explorer: registration.map((l) => tx(sepolia, l.transactionHash)),
    sourceTransactions: registration.map((l) => (l.sourceTransactionHash ? tx(celo, l.sourceTransactionHash) : null)),
  };
  const registered = registration.every((l) => l.status === "CONFIRMED");
  check(registered, "the registration confirmed");
  if (registered) {
    check(await eventually(() => isValidKey(pub.sepolia, sepolia, wallet.address, s3.keyId)), "Sepolia: the KeyStore lists the key as valid");
  } else {
    // The other half of the rule: the grant returned a live key and did not throw.
    console.log("    the grant had already returned a working session; this failure reached the caller through `registration` and onStatus only");
  }

  console.log("\n[3d] await cacheSync (the proof into the Celo Sepolia KeyStoreCache)");
  const cacheLegs = await s3.cacheSync;
  const cacheAfter = since(t0);
  console.log(`    resolved ${cacheAfter}s after the grant started`);
  for (const l of legLines(cacheLegs)) console.log(`      ${l}`);
  out.cacheSync = {
    secondsAfterGrantStart: cacheAfter,
    legs: legLines(cacheLegs),
    explorer: cacheLegs.map((l) => tx(celo, l.transactionHash)),
  };
  out.statusEvents = events;
  if (registered) {
    check(cacheLegs.every((l) => l.status === "CONFIRMED"), "the cache proof confirmed");
    check(
      await eventually(async () => {
        const entry = await readCachedKey(pub.celo, keyStoreCacheOf(celo), wallet.address, s3.keyId);
        return entry.publicKey !== "0x" && !entry.revoked;
      }),
      "Celo Sepolia: the KeyStoreCache holds the key",
    );
  } else {
    check(cacheLegs.every((l) => l.status === "SKIPPED"), "no cache proof was attempted for a key that is not registered");
  }
  out.bnbAfterCacheSync = await untouched("BNB testnet", pub.bnb, wallet.address, {
    network: bnb,
    client: pub.bnb,
    keyIds: [s3.keyId],
  });

  console.log("\n[3e] revokeSession({ ..., chainId: 11142220 }) and its proof");
  t = performance.now();
  const r3 = await client.revokeSession({ wallet, signer: admin, session: s3, chainId: 11142220 });
  console.log(`    returned in ${since(t)}s: ${r3.status}  ${tx(celo, r3.transactionHash)}`);
  for (const l of legLines(r3.legs)) console.log(`      ${l}`);
  const revokeReturned = since(t);
  check(typeof r3.transactionHash === "string", "the result carries transactionHash");
  check(
    await eventually(async () => (await accountKeyHashes(pub.celo, wallet.address))?.includes(s3.keyHash) === false),
    "Celo Sepolia: the account no longer holds the key",
  );
  check(await eventually(async () => !(await isValidKey(pub.sepolia, sepolia, wallet.address, s3.keyId))), "Sepolia: the KeyStore no longer lists the key as valid");
  const revokeProof = await r3.cacheSync;
  console.log(`    proof resolved ${since(t)}s after the revoke started`);
  for (const l of legLines(revokeProof)) console.log(`      ${l}`);
  out.revoke = {
    returnedAfterSeconds: revokeReturned,
    status: r3.status,
    transactionHash: r3.transactionHash,
    explorer: tx(celo, r3.transactionHash),
    legsAtReturn: legLines(r3.legs),
    proofSecondsAfterRevokeStart: since(t),
    proofLegs: legLines(revokeProof),
    proofExplorer: revokeProof.map((l) => tx(celo, l.transactionHash)),
  };
  if (registered) {
    check(revokeProof.length > 0 && revokeProof.every((l) => l.status === "CONFIRMED"), "the post-revocation proof confirmed");
    check(
      await eventually(async () => (await readCachedKey(pub.celo, keyStoreCacheOf(celo), wallet.address, s3.keyId)).revoked),
      "Celo Sepolia: the KeyStoreCache reports the key as revoked",
    );
  } else {
    check(revokeProof.length === 0, "nothing to prove: the key never reached the KeyStore");
  }

  // ── 5. Several chains in one call. ──
  console.log("\n[5] grantSession({ ..., chainIds: [97, 11142220] })");
  await fund(bnb, pub.bnb, wallet.address, BNB_FUNDING_BOTH);
  const bothPermissions = { calls: [{ to: funder }], spend: [{ limit: parseEther("0.002"), period: "day" as const }] };
  t = performance.now();
  let s5: GrantSessionResult | undefined;
  const bothErr = await thrownBy(async () => {
    s5 = await client.grantSession({
      wallet,
      signer: admin,
      sessionSigner: signerFromPrivateKey(generatePrivateKey()),
      permissions: bothPermissions,
      expiry: expiry(),
      chainIds: [97, 11142220],
    });
  });
  check(bothErr === undefined, `it does not throw${bothErr ? ` (${safe(String((bothErr as Error).message)).split("\n")[0]})` : ""}`);
  if (!s5) return;
  console.log(`    returned in ${since(t)}s: ${s5.status}`);
  for (const l of legLines(s5.legs)) console.log(`      ${l}`);
  const accounts = s5.legs.filter((l) => l.kind === "account");
  out.both = {
    seconds: since(t),
    status: s5.status,
    transactionHash: s5.transactionHash ?? null,
    legsAtReturn: legLines(s5.legs),
    explorer: accounts.map((l) => tx(l.chainId === 97 ? bnb : celo, l.transactionHash)),
  };
  check(
    accounts.filter((l) => l.status === "CONFIRMED").map((l) => l.chainId).sort((a, b) => a - b).join() === "97,11142220",
    "an account leg confirmed on each chain",
  );
  check(s5.transactionHash === undefined, "no single transactionHash on a multi-chain grant");
  check(
    await eventually(async () => (await accountKeyHashes(pub.bnb, wallet.address))?.includes(s5!.keyHash) === true),
    "BNB testnet: the account holds the key",
  );
  check(
    await eventually(async () => (await accountKeyHashes(pub.celo, wallet.address))?.includes(s5!.keyHash) === true),
    "Celo Sepolia: the account holds the key",
  );
  const bothRegistration = await s5.registration;
  for (const l of legLines(bothRegistration)) console.log(`      registration: ${l}`);
  (out.both as Record<string, unknown>).registration = legLines(bothRegistration);
  (out.both as Record<string, unknown>).registrationSeconds = since(t);

  console.log("\n[5b] revokeSession: one call, both chains");
  t = performance.now();
  const r5Err = await thrownBy(async () => {
    const r5 = await client.revokeSession({ wallet, signer: admin, session: s5! });
    console.log(`    returned in ${since(t)}s: ${r5.status}  ${tx(bnb, r5.transactionHash)}`);
    for (const l of legLines(r5.legs)) console.log(`      ${l}`);
    out.bothRevoke = { seconds: since(t), status: r5.status, transactionHash: r5.transactionHash, explorer: tx(bnb, r5.transactionHash), legs: legLines(r5.legs) };
    const revoked = r5.legs.filter((l) => l.kind === "account" && l.status === "CONFIRMED").map((l) => l.chainId).sort((a, b) => a - b);
    check(revoked.join() === "97,11142220", `the account revoke confirmed on both chains (${revoked.join(", ")})`);
  });
  if (r5Err) {
    out.bothRevoke = describeThrown(r5Err);
    if (r5Err instanceof SessionRevokeError) (out.bothRevoke as Record<string, unknown>).legs = legLines(r5Err.result.legs);
    check(false, `the revoke on both chains went through (${safe(String((r5Err as Error).message)).split("\n")[0]})`);
  }
}

/** Sends what a throwaway wallet still holds back to the funder, as plain transactions from its own key. */
async function sweep(funder: Address): Promise<void> {
  console.log("\n[sweep] return leftover funds to the funder");
  const returned: string[] = [];
  record.returned = returned;
  for (const { key, networks } of toSweep) {
    const account = privateKeyToAccount(key);
    for (const { n, client, tokens } of networks) {
      const w = createWalletClient({ account, chain: n.chain, transport: http(n.publicRpcUrl) });
      for (const token of tokens ?? []) {
        try {
          const held = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
          if (held === 0n) continue;
          const [symbol, decimals] = await Promise.all([
            client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
            client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
          ]);
          const hash = await w.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [funder, held] });
          const receipt = await client.waitForTransactionReceipt({ hash });
          returned.push(`${account.address} ${n.chain.name}: returned ${formatUnits(held, decimals)} ${symbol} (${receipt.status}) ${tx(n, hash)}`);
        } catch (err) {
          returned.push(`${account.address} ${n.chain.name}: token sweep failed: ${safe(String((err as Error).message)).split("\n")[0]}; key is in the shared env`);
        }
      }
      const symbol = n.chain.nativeCurrency.symbol;
      // A public RPC can serve the balance from before the wallet's last fee was taken, and a
      // transfer sized from that is refused. Read again and retry rather than strand the funds.
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const balance = await client.getBalance({ address: account.address });
          if (balance === 0n) break;
          // A plain value transfer: 21000 gas, with room. Priced the chain's own way (a legacy
          // price is refused on Celo Sepolia).
          const gas = 30_000n;
          const fees = await client.estimateFeesPerGas();
          const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
          const value = balance - gas * perGas;
          if (value <= 0n) {
            returned.push(`${account.address} ${n.chain.name}: ${formatEther(balance)} ${symbol} left, below the transfer cost`);
            break;
          }
          const hash = await w.sendTransaction({
            to: funder,
            value,
            gas,
            ...(fees.maxFeePerGas !== undefined
              ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
              : { gasPrice: perGas }),
          });
          const receipt = await client.waitForTransactionReceipt({ hash });
          returned.push(`${account.address} ${n.chain.name}: returned ${formatEther(value)} ${symbol} (${receipt.status}) ${tx(n, hash)}`);
          break;
        } catch (err) {
          if (attempt < 5) {
            await sleep(6_000);
            continue;
          }
          returned.push(`${account.address} ${n.chain.name}: sweep failed: ${safe(String((err as Error).message)).split("\n")[0]}; key is in the shared env`);
        }
      }
    }
  }
  for (const line of returned) console.log(`    ${line}`);
}

async function main(): Promise<void> {
  console.log("@altananetwork/sdk: a grant goes to one chain (client on BNB testnet + Celo Sepolia)");
  console.log("======================================================================================");
  const funder = privateKeyToAccount(FUNDER_KEY).address;
  const [bnbBalance, celoBalance] = await Promise.all([
    pub.bnb.getBalance({ address: funder }),
    pub.celo.getBalance({ address: funder }),
  ]);
  record.funderBefore = { tBNB: formatEther(bnbBalance), CELO: formatEther(celoBalance) };
  console.log(`funder ${funder}: ${formatEther(bnbBalance)} tBNB, ${formatEther(celoBalance)} CELO`);
  if (ONLY !== "celo" && bnbBalance < BNB_FUNDING * 2n) throw new Error(`the funder needs at least ${formatEther(BNB_FUNDING * 2n)} tBNB`);
  if (ONLY !== "bnb" && celoBalance < CELO_FUNDING + parseEther("0.5")) throw new Error(`the funder needs at least ${formatEther(CELO_FUNDING + parseEther("0.5"))} CELO`);

  // Two chains on purpose: the point is what a grant does NOT touch.
  const client = createClient({ chains: [bnb, celo] });
  try {
    if (ONLY !== "celo") await bnbHalf(client, funder);
    if (ONLY !== "bnb") await celoHalf(client, funder);
  } catch (err) {
    failures.push(`crashed: ${safe(String((err as Error)?.message ?? err)).split("\n")[0]}`);
    record.crash = describeThrown(err);
    console.error(`\ncrashed: ${safe(String((err as Error)?.stack ?? err))}`);
  } finally {
    await sweep(funder);
    const [bnbAfter, celoAfter] = await Promise.all([
      pub.bnb.getBalance({ address: funder }),
      pub.celo.getBalance({ address: funder }),
    ]);
    record.funderAfter = { tBNB: formatEther(bnbAfter), CELO: formatEther(celoAfter) };
    record.spent = { tBNB: formatEther(bnbBalance - bnbAfter), CELO: formatEther(celoBalance - celoAfter) };
    record.failures = failures;
    record.seconds = since(started);
    if (process.env.ONE_CHAIN_OUT) {
      writeFileSync(process.env.ONE_CHAIN_OUT, JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    }
    console.log(`\nfunder spent: ${(record.spent as { tBNB: string }).tBNB} tBNB, ${(record.spent as { CELO: string }).CELO} CELO`);
  }

  console.log("\n======================================================================================");
  console.log(`Total wall-clock: ${at()}`);
  if (failures.length > 0) {
    console.log(`Result: FAIL (${failures.length})`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("Result: PASS");
}

main().catch((err) => {
  console.error(`\nlive-one-chain-grants crashed: ${safe(String((err as Error)?.message ?? err))}`);
  process.exit(1);
});
