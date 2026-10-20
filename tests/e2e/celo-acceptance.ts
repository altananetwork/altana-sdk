/**
 * THE acceptance run for Celo delivery: steps 1 to 6 of the end goal in
 * `celo-harness/PLAN-delivery.md`, in one command, as the single test that
 * decides "done".
 *
 *   1  A wallet funded with CELO only, holding zero Sepolia ETH.
 *   2  Gas paid in CELO, and gas paid in USDC from a wallet holding only USDC.
 *   3  A session key usable on Celo at once, with the Ethereum Sepolia KeyStore
 *      registration running behind it, paid from the Celo balance.
 *   4  The key used: several transactions at once from TWO keys, and
 *      back-to-back transactions from ONE key. All first try, no nonce errors.
 *   5  The key valid in the Celo mirror, once the L1 anchor allows.
 *   6  Revoked: refused on Celo, and the mirror shows it revoked.
 *
 * Order, and why. Steps 1 to 4 finish in about five minutes and their table is
 * printed as soon as they are done. The two mirror steps come last because
 * each waits for Celo Sepolia to anchor an Ethereum Sepolia block, which takes
 * 15 to 20 minutes and is a property of the chain rather than of this code.
 * Step 5 has to run BEFORE the revoke: a cache proof proves the KeyStore entry
 * at an anchored block, so proving "valid" after revoking would prove the
 * revocation instead.
 *
 * Relay: relay-staging, because the background registration needs interop,
 * which the live testnet relay does not have (R1). The report says which relay
 * it ran against and which SDK build, both as facts of the run rather than
 * assumptions about it.
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO (>= 5) and >= 1 USDC on Celo Sepolia
 *   CELO_SEPOLIA_RPC_URL   optional read-RPC override
 *   SEPOLIA_RPC_URL        optional registry-chain read RPC (needs eth_getProof)
 *   ACCEPT_RELAY           optional relay override
 *   ACCEPT_FUND_CELO       CELO given to the main wallet (default 8)
 *   ACCEPT_STEPS           subset of 1,2a,2b,3,4,5,6 (default all)
 *   ACCEPT_EVIDENCE_DIR    where the report lands (default: the harness's
 *                          evidence folder when this is a harness worktree,
 *                          otherwise next to this script)
 *
 * Run: bun run acceptance        (from tests/e2e)
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  isCachedKeyValid,
  keyStoreCacheOf,
  readCachedKey,
  readL1Anchor,
  sdkBuild,
  signerFromPrivateKey,
  waitForBalance,
  type FeeCurrency,
  type GrantLeg,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  padHex,
  parseEther,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RELAY = process.env.ACCEPT_RELAY ?? "https://relay-staging-production-2657.up.railway.app";
/**
 * How much CELO the main wallet gets.
 *
 * Priced, not guessed: a relayed operation on relay-staging quotes about 0.4
 * CELO at `intentBuffer` 2,150,000 (measured 2026-10-20), and this run makes
 * fifteen of them — one in 2a, three in 3 (the authorization and the two
 * cross-chain source intents), seven in 4 (a second authorization, four at
 * once, two back to back), one proof in 5, and three in 6 (the two revoke legs
 * and the revocation proof). That is 6.0 CELO at the quoted rate, so 6 is the
 * break-even and 8 is the figure: the first run of this funded 3 and died on
 * the LAST operation of step 6 with 0.3616 CELO left, which is less than one
 * trivial operation's quote.
 */
const FUND_CELO = parseEther(process.env.ACCEPT_FUND_CELO ?? "8");
/** Whole USDC given to the token-only wallet of step 2b. */
const FUND_USDC = process.env.ACCEPT_FUND_USDC ?? "1";
/** What a probe transaction sends, so it moves value rather than only status. */
const PROBE = parseEther("0.001");
const ONLY = process.env.ACCEPT_STEPS?.split(",").map((s) => s.trim().toLowerCase());
// The harness keeps its evidence four levels up from tests/e2e; a plain
// clone of the SDK has no such folder, and a report nobody can find is a
// run wasted, so it lands beside this script instead.
const HARNESS_EVIDENCE = "../../../../evidence";
const EVIDENCE_DIR =
  process.env.ACCEPT_EVIDENCE_DIR ?? (existsSync(HARNESS_EVIDENCE) ? HARNESS_EVIDENCE : ".");

const celoRpc = process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA.publicRpcUrl;
const sepoliaRpc = process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl;

const sepolia: NetworkConfig = { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: sepoliaRpc };
/**
 * Celo Sepolia as the one execution network, with Ethereum Sepolia reached
 * only as its registry chain. Sepolia is deliberately not an execution
 * network: the KeyStore write has to be paid from the Celo balance for step 3
 * to mean anything.
 */
const celo: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  publicRpcUrl: celoRpc,
  registry: { kind: "cached", l1: sepolia, keyStoreCache: keyStoreCacheOf(CELO_SEPOLIA) },
};
const CACHE = keyStoreCacheOf(celo);
const EXPLORER = celo.explorer ?? "https://sepolia.celoscan.io";
const L1_EXPLORER = "https://sepolia.etherscan.io";

const pub = createPublicClient({ chain: celoSepolia, transport: http(celoRpc) }) as PublicClient;
const l1 = createPublicClient({ transport: http(sepoliaRpc) }) as PublicClient;
const client = createClient({ chains: [celo] });

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY. Load the shared file: " +
      "set -a; source <ecosystem>/.env.testnet; set +a",
  );
}
const funder = privateKeyToAccount(TEST_FUNDER_KEY);
const funderWallet = createWalletClient({ account: funder, chain: celoSepolia, transport: http(celoRpc) });

const KEYSTORE_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
const GET_NONCE_ABI = [
  {
    name: "getNonce",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "seqKey", type: "uint192" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
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

/**
 * The lane a key's intents run on, derived here rather than imported: `0xa17a`
 * then 176 bits of `keccak(keyHash)`. Checking the SDK against its own
 * constant would check nothing.
 */
const keyHashOf = (signer: Address): Hex =>
  keccak256(
    encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, keccak256(padHex(signer, { size: 32 }))]),
  );
const laneOfSigner = (signer: Address): bigint =>
  (0xa17an << 176n) | (BigInt(keccak256(keyHashOf(signer))) & ((1n << 176n) - 1n));
const laneOf = (nonce: bigint) => nonce >> 64n;
const counterOf = (nonce: bigint) => nonce & ((1n << 64n) - 1n);

// ---------------------------------------------------------------------------
// The wire: one prepare per transaction is the rule step 1 of the plan states
// ---------------------------------------------------------------------------

/**
 * Every JSON-RPC call to the relay, request side only.
 *
 * Step 4's real claim is not "four transactions confirmed" — they can confirm
 * while the SDK is still racing itself, which is what made the live-relay
 * failure look intermittent (`2026-10-19-qa-lane-live-relay.md`). The claim is
 * the rule: a key's next nonce is handed out only after the previous
 * transaction is MINED, so each transaction costs exactly one
 * `wallet_prepareCalls` and no prepare is ever refused `InvalidNonce`. A retry
 * means the SDK prepared ahead of the chain and got caught doing it.
 *
 * Request side only on purpose: reading each response body delays the next
 * prepare enough to change the outcome being measured, which happened while
 * tracking the live-relay failure.
 */
type Wire = { at: string; method: string; nonces: string[] };
const wire: Wire[] = [];
function noncesIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) noncesIn(v, found);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "nonce" && (typeof v === "string" || typeof v === "number")) found.push(String(v));
      else noncesIn(v, found);
    }
  }
  return found;
}
{
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.body && typeof init.body === "string" && url.startsWith(RELAY)) {
      try {
        const body = JSON.parse(init.body) as { method?: string };
        wire.push({ at: new Date().toISOString(), method: body.method ?? "?", nonces: noncesIn(body) });
      } catch {
        /* not json, nothing to record */
      }
    }
    return original(input as never, init as never);
  }) as typeof fetch;
}
/** Prepares seen since a mark, with the lane and counter each carried. */
function preparesSince(mark: number) {
  return wire.slice(mark).filter((w) => w.method === "wallet_prepareCalls");
}

// ---------------------------------------------------------------------------
// The step table
// ---------------------------------------------------------------------------

type Tx = { what: string; chain: "celo" | "sepolia"; hash: Hex };
type Step = {
  id: string;
  title: string;
  status: "PASS" | "FAIL" | "SKIPPED" | "PENDING";
  detail: string[];
  txs: Tx[];
  seconds?: number;
};
const steps: Step[] = [];
const wallets: { address: Address; key: Hex; what: string }[] = [];

class Fail extends Error {}
function must(cond: boolean, message: string) {
  if (!cond) throw new Fail(message);
}

async function step(id: string, title: string, body: (s: Step) => Promise<void>): Promise<Step> {
  const s: Step = { id, title, status: "PENDING", detail: [], txs: [] };
  steps.push(s);
  if (ONLY && !ONLY.includes(id.toLowerCase())) {
    s.status = "SKIPPED";
    s.detail.push("not in ACCEPT_STEPS");
    console.log(`\n[${id}] ${title}\n    SKIPPED`);
    return s;
  }
  console.log(`\n[${id}] ${title}`);
  const started = Date.now();
  try {
    await body(s);
    s.status = "PASS";
  } catch (err) {
    s.status = "FAIL";
    const line = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    s.detail.push(`FAILED: ${line}`);
    console.log(`    FAIL ${line}`);
    if (!(err instanceof Fail)) console.error(err);
  }
  s.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  console.log(`    ${s.status} in ${s.seconds}s`);
  return s;
}

const note = (s: Step, line: string) => {
  s.detail.push(line);
  console.log(`    ${line}`);
};
const tx = (s: Step, what: string, hash: Hex | undefined, chain: "celo" | "sepolia" = "celo") => {
  if (!hash) return;
  s.txs.push({ what, chain, hash });
  console.log(`    ${what}: ${(chain === "celo" ? EXPLORER : L1_EXPLORER)}/tx/${hash}`);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh wallet whose key is saved before it is funded, so nothing strands. */
async function freshWallet(what: string) {
  const key = generatePrivateKey();
  const signer = signerFromPrivateKey(key);
  const wallet = await client.createWallet({ signer });
  appendFileSync(
    testnetEnvFile(),
    `\n# celo-acceptance ${what} ${wallet.address}, ${new Date().toISOString()}\n` +
      `ACCEPT_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${key}\n`,
  );
  wallets.push({ address: wallet.address, key, what });
  return { wallet, signer, key };
}

const sendProbe = (to: Address) => ({ to, value: PROBE, data: "0x" as Hex });

/**
 * What the wallet still holds, in the step's own notes. The first run of this
 * failed its last operation for want of CELO and the report did not say so:
 * the balance had to be reconstructed afterwards from the refund. A step that
 * can fail for lack of funds should record the funds.
 */
async function noteBalance(s: Step) {
  const bal = await pub.getBalance({ address: S.wallet!.address });
  note(s, `the wallet holds ${formatEther(bal)} CELO going in (one relayed operation quotes about 0.4)`);
}

async function erc20Balance(token: Address, who: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
}

/**
 * An ERC-20 balance that has settled, polled.
 *
 * One read taken straight after a transfer lands is the trap this script fell
 * into twice in a day: forno is load-balanced, a node that has not seen the
 * block yet answers with the old value, and the number is then wrong in either
 * direction. It printed a fee of "-1 USDC" — a zero read before the funding,
 * a full read after the charge — and it had the refund quote a sweep against a
 * balance the wallet no longer held, which the relay rejected as an asset
 * deficit, stranding the token. Same trap as the lane counters, same cure.
 *
 * With `settled`, it polls until the balance is one the caller can explain.
 * Without, it polls until two reads in a row agree. Either way it gives up
 * after about twelve seconds and returns the last thing it saw, because a
 * refund that cannot read a balance should still try.
 */
async function erc20BalanceSettled(
  token: Address,
  who: Address,
  settled?: (v: bigint) => boolean,
): Promise<bigint> {
  let last: bigint | undefined;
  for (let i = 0; i < 8; i++) {
    const v = await erc20Balance(token, who).catch(() => undefined);
    if (v !== undefined) {
      if (settled ? settled(v) : last === v) return v;
      last = v;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last ?? 0n;
}

function isRegistered(wallet: Address, keyId: Hex): Promise<boolean> {
  return l1
    .readContract({ address: sepolia.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [wallet, keyId] })
    .catch(() => false) as Promise<boolean>;
}

/** A lane's counter from the account, polled: a load-balanced RPC serves stale state. */
async function laneCounter(wallet: Address, lane: bigint, want?: bigint): Promise<bigint | undefined> {
  let last: bigint | undefined;
  for (let i = 0; i < 10; i++) {
    last = (await pub
      .readContract({ address: wallet, abi: GET_NONCE_ABI, functionName: "getNonce", args: [lane] })
      .then((n) => counterOf(n as bigint))
      .catch(() => undefined)) as bigint | undefined;
    if (want === undefined || last === want) return last;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return last;
}

/** Every intent of this wallet in a transaction, with its lane and counter. */
async function intentsIn(hash: Hex, wallet: Address) {
  const receipt = await pub.getTransactionReceipt({ hash });
  return receipt.logs
    .filter((l) => l.topics[0] === INTENT_EXECUTED)
    .map(
      (l) =>
        decodeEventLog({ abi: INTENT_EXECUTED_ABI, data: l.data, topics: l.topics as [Hex, Hex, Hex] })
          .args as unknown as { eoa: Address; nonce: bigint; err: Hex },
    )
    .filter((a) => a.eoa.toLowerCase() === wallet.toLowerCase())
    .map((a) => ({ lane: laneOf(a.nonce), counter: counterOf(a.nonce), err: a.err }));
}

/** One execute, with whatever the SDK said about it kept whole. */
async function runExecute(args: Parameters<typeof client.execute>[0]) {
  try {
    const r = await client.execute(args);
    const raw = JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return { ok: r.status === "CONFIRMED", status: String(r.status), hash: r.transactionHash as Hex | undefined, raw };
  } catch (err) {
    const message = (err as Error).message.split("\n")[0]!;
    return { ok: false, status: "THREW", hash: undefined, raw: { message } };
  }
}

const nonceWords = /InvalidNonce|invalid nonce|nonce/i;
const looksLikeNonce = (r: { status: string; raw: unknown }) =>
  nonceWords.test(`${r.status} ${JSON.stringify(r.raw)}`);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

type State = {
  wallet?: { address: Address };
  signer?: ReturnType<typeof signerFromPrivateKey>;
  sessionA?: GrantResult;
  sessionB?: GrantResult;
  usdc?: FeeCurrency;
};
type GrantResult = Awaited<ReturnType<typeof client.grantSession>>;
const S: State = {};
const startedAt = new Date().toISOString();

async function main() {
  // The build is the first line, because a run that does not state its own
  // code cannot be used as evidence about that code.
  console.log(`sdk build ${sdkBuild.describe}${sdkBuild.dirty ? " (DIRTY)" : ""}, built ${sdkBuild.builtAt}`);
  console.log("Celo acceptance: steps 1 to 6 of PLAN-delivery.md");
  console.log("=================================================");
  console.log(`relay     ${RELAY}`);
  console.log(`celo RPC  ${celoRpc.replace(/\/[^/]*$/, "/…")}`);
  console.log(`mirror    ${CACHE}`);

  const funderCelo = await pub.getBalance({ address: funder.address });
  console.log(`funder    ${funder.address}: ${formatEther(funderCelo)} CELO`);
  must(funderCelo >= FUND_CELO + parseEther("1"), `the funder needs ${formatEther(FUND_CELO + parseEther("1"))} CELO`);

  const fees = await client.feeCurrencies();
  S.usdc = fees.currencies.find((c) => c.uid === "usdc" || c.symbol.toUpperCase() === "USDC");

  // ---- 1. a wallet with CELO and no ETH -----------------------------------
  await step("1", "A wallet funded with CELO only, zero Sepolia ETH", async (s) => {
    const { wallet, signer } = await freshWallet("main wallet");
    S.wallet = wallet;
    S.signer = signer;
    const fundTx = await funderWallet.sendTransaction({
      to: wallet.address,
      value: FUND_CELO,
      account: funder,
      chain: celoSepolia,
    });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    await waitForBalance(pub, wallet.address, FUND_CELO, 120_000);
    tx(s, "fund the wallet with CELO", fundTx);
    note(s, `wallet ${wallet.address} holds ${formatEther(FUND_CELO)} CELO`);
    const ethOnL1 = await l1.getBalance({ address: wallet.address });
    must(ethOnL1 === 0n, `the wallet holds ${formatEther(ethOnL1)} Sepolia ETH, must hold none`);
    note(s, "Sepolia ETH is 0, as it must be for every step up to the registration");
  });

  // ---- 2a. gas in CELO ----------------------------------------------------
  await step("2a", "Gas paid in CELO", async (s) => {
    must(!!S.wallet && !!S.signer, "step 1 produced no wallet");
    const r = await runExecute({ wallet: S.wallet!, signer: S.signer!, calls: sendProbe(funder.address) });
    tx(s, "execute paying CELO", r.hash);
    must(r.ok, `execute came back ${r.status}: ${JSON.stringify(r.raw)}`);
    const feeToken = (r.raw as { feeToken?: string }).feeToken;
    must(
      !feeToken || feeToken === "0x0000000000000000000000000000000000000000",
      `expected the fee in native CELO, the relay charged ${feeToken}`,
    );
    note(s, "the relay charged the fee in native CELO");
  });

  // ---- 2b. gas in USDC, from a wallet holding only USDC -------------------
  await step("2b", "Gas paid in USDC, from a wallet holding only USDC", async (s) => {
    const usdc = S.usdc;
    must(!!usdc, "the relay does not list USDC as a fee token");
    const amount = BigInt(FUND_USDC) * 10n ** BigInt(usdc!.decimals);
    const held = await erc20Balance(usdc!.address as Address, funder.address);
    must(
      held >= amount,
      `the funder holds ${formatUnits(held, usdc!.decimals)} USDC, needs ${FUND_USDC}; ` +
        "top up at https://faucet.circle.com (Celo Sepolia)",
    );

    const { wallet, signer } = await freshWallet("USDC-only wallet");
    const sendUsdc = await funderWallet.writeContract({
      address: usdc!.address as Address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [wallet.address, amount],
      account: funder,
      chain: celoSepolia,
    });
    await pub.waitForTransactionReceipt({ hash: sendUsdc });
    tx(s, `fund the wallet with ${FUND_USDC} USDC`, sendUsdc);
    const native = await pub.getBalance({ address: wallet.address });
    must(native === 0n, `this wallet must hold no CELO, holds ${formatEther(native)}`);
    note(s, `wallet ${wallet.address} holds ${FUND_USDC} USDC and 0 CELO`);

    // The wallet was empty and has just been funded: anything else is a stale read.
    const before = await erc20BalanceSettled(usdc!.address as Address, wallet.address, (v) => v === amount);
    // Name no feeToken: the relay has to pick the only token the wallet holds.
    const r = await runExecute({ wallet, signer, calls: { to: funder.address, value: 0n, data: "0x" } });
    tx(s, "execute paying USDC", r.hash);
    must(r.ok, `execute came back ${r.status}: ${JSON.stringify(r.raw)}`);
    const feeToken = (r.raw as { feeToken?: string }).feeToken ?? "";
    must(
      feeToken.toLowerCase() === usdc!.address.toLowerCase(),
      `expected the fee in USDC (${usdc!.address}), the relay charged ${feeToken}`,
    );
    const after = await erc20BalanceSettled(usdc!.address as Address, wallet.address, (v) => v < before);
    const charged = before - after;
    must(
      charged > 0n,
      `the wallet's USDC balance did not fall after the execute: ${formatUnits(before, usdc!.decimals)} before, ` +
        `${formatUnits(after, usdc!.decimals)} after. The fee was charged in USDC, so this is a stale read, ` +
        "and the charge this step reports would be meaningless",
    );
    note(s, `charged ${formatUnits(charged, usdc!.decimals)} USDC; the wallet still holds 0 CELO`);
  });

  // ---- 3. the grant: usable at once, registration behind it ---------------
  await step("3", "A session key usable on Celo at once, KeyStore registration behind it, paid from Celo", async (s) => {
    must(!!S.wallet && !!S.signer, "step 1 produced no wallet");
    const sessionKey = signerFromPrivateKey(generatePrivateKey());
    const events: string[] = [];
    const t0 = Date.now();
    const grant = await client.grantSession({
      wallet: S.wallet!,
      signer: S.signer!,
      sessionSigner: sessionKey,
      permissions: {
        calls: [{ to: funder.address }],
        // The session pays the relay's fee out of its own cap, and at the
        // 2,150,000 intent buffer one intent is about 0.4 CELO: a small cap is
        // not a tight session but an unusable one.
        spend: [{ limit: parseEther("2"), period: "day" }],
      },
      expiry: Math.floor(Date.now() / 1000) + 3600,
      onStatus: (status, detail) => {
        const line =
          `t+${((Date.now() - t0) / 1000).toFixed(1)}s ${status}` +
          `${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}` +
          `${detail?.reason ? ` — ${detail.reason}` : ""}`;
        events.push(line);
        console.log(`      ${line}`);
      },
    });
    S.sessionA = grant;
    const account = grant.legs.find((l: GrantLeg) => l.kind === "account" && l.chainId === celo.chainId);
    const registryAtReturn = grant.legs.find((l: GrantLeg) => l.kind === "registry");
    tx(s, "session authorized on the Celo account", account?.transactionHash as Hex | undefined);
    must(grant.status === "granted", `the grant came back ${grant.status}`);
    must(account?.status === "CONFIRMED", `the Celo authorization came back ${account?.status}`);
    note(s, `grantSession returned in ${((Date.now() - t0) / 1000).toFixed(1)}s with the key live on Celo`);
    must(
      registryAtReturn?.status === "PENDING",
      `the registry leg read ${registryAtReturn?.status} at return, so the grant waited for the L1`,
    );
    note(s, "the Sepolia registry leg read PENDING at return: the grant did not wait for the L1");

    // The key the account holds is the key the registration will name.
    must(
      grant.keyHash === keyHashOf(sessionKey.address as Address),
      "the result's keyHash is not the account's key hash for this signer",
    );

    const beforeWrite = await isRegistered(S.wallet!.address, grant.keyId);
    must(beforeWrite === false, "the KeyStore already lists this key, so the write proves nothing");

    const registryLegs = await grant.registration;
    const leg = registryLegs.find((l: GrantLeg) => l.chainId === sepolia.chainId);
    tx(s, "KeyStore registration", leg?.transactionHash as Hex | undefined, "sepolia");
    if (leg?.rootRegistration?.transactionHash) {
      tx(s, "root registration (first-time wallet)", leg.rootRegistration.transactionHash as Hex, "sepolia");
    }
    tx(s, "the Celo intent that paid for it", leg?.sourceTransactionHash as Hex | undefined);
    must(leg?.status === "CONFIRMED", `the registration came back ${leg?.status}: ${leg?.reason ?? ""}`);
    must(
      leg?.fundedFromChainId === celo.chainId,
      `the write says it was funded from chain ${leg?.fundedFromChainId}, not Celo (${celo.chainId})`,
    );
    note(s, `the write was paid from chain ${leg?.fundedFromChainId} (Celo), not from Sepolia ETH`);
    must(await isRegistered(S.wallet!.address, grant.keyId), "the KeyStore does not list the key after the write");
    note(s, "KeyStore.isValidKey is true on Ethereum Sepolia");
    s.detail.push(...events.map((e) => `status: ${e}`));
  });

  // ---- 4. the key used: two keys at once, and one key back to back --------
  await step("4", "Several transactions at once from two keys, and back-to-back from one key", async (s) => {
    must(!!S.sessionA, "step 3 produced no session");
    must(!!S.wallet && !!S.signer, "step 1 produced no wallet");

    // A second key, with no registry write of its own: what is under test here
    // is the nonce lanes, and a second L1 write would only cost time.
    const keyB = signerFromPrivateKey(generatePrivateKey());
    const grantB = await client.grantSession({
      wallet: S.wallet!,
      signer: S.signer!,
      sessionSigner: keyB,
      register: false,
      permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("2"), period: "day" }] },
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    S.sessionB = grantB;
    must(grantB.status === "granted", `the second grant came back ${grantB.status}`);
    const accountB = grantB.legs.find((l: GrantLeg) => l.kind === "account" && l.chainId === celo.chainId);
    tx(s, "second session authorized on the Celo account", accountB?.transactionHash as Hex | undefined);

    const laneA = laneOfSigner((S.sessionA!.signer as { address: Address }).address);
    const laneB = laneOfSigner(keyB.address as Address);
    must(laneA !== laneB, "the two keys derive the same lane");
    note(s, `lane A 0x${laneA.toString(16).slice(0, 8)}…, lane B 0x${laneB.toString(16).slice(0, 8)}…`);

    // Four at once, two per key.
    const wireMark = wire.length;
    const fired = Date.now();
    const burst = await Promise.all([
      runExecute({ session: S.sessionA as unknown as Session, chainId: celo.chainId, calls: sendProbe(funder.address) }),
      runExecute({ session: S.sessionA as unknown as Session, chainId: celo.chainId, calls: sendProbe(funder.address) }),
      runExecute({ session: grantB as unknown as Session, chainId: celo.chainId, calls: sendProbe(funder.address) }),
      runExecute({ session: grantB as unknown as Session, chainId: celo.chainId, calls: sendProbe(funder.address) }),
    ]);
    note(s, `four transactions from two keys, fired together, settled in ${((Date.now() - fired) / 1000).toFixed(1)}s`);
    burst.forEach((r, i) => tx(s, `concurrent tx ${i} (${i < 2 ? "key A" : "key B"})`, r.hash));
    const nonceFailures = burst.filter(looksLikeNonce);
    must(
      nonceFailures.length === 0,
      `${nonceFailures.length} of 4 concurrent transactions hit a nonce error: ${JSON.stringify(nonceFailures.map((r) => r.raw))}`,
    );
    const failed = burst.filter((r) => !r.ok);
    must(
      failed.length === 0,
      `${failed.length} of 4 concurrent transactions did not confirm first try: ${JSON.stringify(failed.map((r) => ({ status: r.status, raw: r.raw })))}`,
    );

    // Two back to back on one key, which is the strictly sequential case.
    const seq: typeof burst = [];
    for (let i = 0; i < 2; i++) {
      seq.push(
        await runExecute({
          session: S.sessionA as unknown as Session,
          chainId: celo.chainId,
          calls: sendProbe(funder.address),
        }),
      );
    }
    seq.forEach((r, i) => tx(s, `back-to-back tx ${i} (key A)`, r.hash));
    must(seq.every((r) => r.ok), `a back-to-back transaction did not confirm: ${JSON.stringify(seq.map((r) => r.status))}`);
    must(seq.filter(looksLikeNonce).length === 0, "a back-to-back transaction hit a nonce error");

    // The lanes, read from the chain and then from the account.
    const onLane: Record<string, bigint[]> = { A: [], B: [] };
    for (const [which, rs] of [["A", [burst[0]!, burst[1]!, ...seq]], ["B", [burst[2]!, burst[3]!]]] as const) {
      for (const r of rs) {
        if (!r.hash) continue;
        const found = await intentsIn(r.hash, S.wallet!.address);
        must(found.length === 1, `expected one intent of this wallet in ${r.hash}, found ${found.length}`);
        const lane = which === "A" ? laneA : laneB;
        must(found[0]!.lane === lane, `an intent of key ${which} ran on lane 0x${found[0]!.lane.toString(16)}`);
        must(found[0]!.err === "0x00000000", `an intent of key ${which} carries err ${found[0]!.err}`);
        onLane[which]!.push(found[0]!.counter);
      }
    }
    for (const which of ["A", "B"] as const) {
      const sorted = [...onLane[which]!].sort((a, b) => Number(a - b));
      must(
        sorted.every((c, i) => c === BigInt(i)),
        `key ${which}'s counters are not consecutive from 0: ${sorted.join(", ")}`,
      );
      note(s, `key ${which}: ${sorted.length} intents on its own lane, counters ${sorted.join(", ")}`);
    }
    // The rule, from the wire: one prepare per transaction, none refused.
    // Six transactions went out in this step (four at once, two back to back).
    const prepares = preparesSince(wireMark);
    const laneHex = (l: bigint) => l.toString(16);
    const onLanePrepares = prepares.filter((p) =>
      p.nonces.some((n) => {
        const lane = laneHex(laneOf(BigInt(n)));
        return lane === laneHex(laneA) || lane === laneHex(laneB);
      }),
    );
    note(s, `${onLanePrepares.length} prepares on the two lanes for 6 transactions`);
    must(
      onLanePrepares.length === 6,
      `expected one prepare per transaction, saw ${onLanePrepares.length} for 6: the SDK prepared a nonce ` +
        "ahead of the chain and had to retry, which is the hazard step 1 of the plan removes",
    );
    const counters = onLanePrepares.map((p) => p.nonces.map((n) => `${laneHex(laneOf(BigInt(n))).slice(0, 8)}:${counterOf(BigInt(n))}`).join(" "));
    const duplicates = counters.filter((c, i) => counters.indexOf(c) !== i);
    must(
      duplicates.length === 0,
      `the same lane and counter was prepared twice (${duplicates.join(", ")}), so an intent was retried`,
    );

    const [countA, countB] = await Promise.all([
      laneCounter(S.wallet!.address, laneA, BigInt(onLane.A!.length)),
      laneCounter(S.wallet!.address, laneB, BigInt(onLane.B!.length)),
    ]);
    must(countA === BigInt(onLane.A!.length), `the account reports ${countA} on lane A, expected ${onLane.A!.length}`);
    must(countB === BigInt(onLane.B!.length), `the account reports ${countB} on lane B, expected ${onLane.B!.length}`);
    note(s, `the account agrees: getNonce(lane A) = ${countA}, getNonce(lane B) = ${countB}`);
  });

  // The fast half is done: print it before the anchor waits.
  console.log("\n--- steps 1 to 4 ---");
  console.log(table());
  writeReport("partial");

  // ---- 5. the mirror, once the anchor allows ------------------------------
  await step("5", "The key valid in the Celo mirror, once the anchor allows", async (s) => {
    const grant = S.sessionA;
    must(!!grant, "step 3 produced no session");
    await noteBalance(s);
    const anchor = await readL1Anchor(pub);
    note(s, `waiting for the Celo anchor (now at Sepolia block ${anchor.number}) to reach the write`);
    const caches = await grant!.cacheSync;
    const leg = caches.find((l: GrantLeg) => l.chainId === celo.chainId);
    tx(s, "cache proof into the Celo mirror", leg?.transactionHash as Hex | undefined);
    must(leg?.status === "CONFIRMED", `the cache proof came back ${leg?.status}: ${leg?.reason ?? ""}`);

    let cached = await readCachedKey(pub, CACHE, S.wallet!.address, grant!.keyId);
    for (let i = 0; i < 20 && (!cached.publicKey || cached.publicKey === "0x"); i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      cached = await readCachedKey(pub, CACHE, S.wallet!.address, grant!.keyId);
    }
    must(!!cached.publicKey && cached.publicKey !== "0x", "the mirror holds no entry for this key");
    must(!cached.revoked, "the mirror's entry is already revoked");
    note(s, `the mirror holds the key, proven from Sepolia block ${cached.sourceBlockNumber}`);
    const valid = await isCachedKeyValid(pub, CACHE, S.wallet!.address, grant!.keyId);
    const now = await readL1Anchor(pub);
    note(
      s,
      `isCachedKeyValid = ${valid} (entry at ${cached.sourceBlockNumber}, anchor now ${now.number}; ` +
        "the cache demands equality, so false here means the anchor has moved on, not that the proof failed)",
    );
    must(valid || cached.sourceBlockNumber !== now.number, "the mirror refuses a key proven at the current anchor");
  });

  // ---- 6. revoke: refused on Celo, and the mirror follows -----------------
  await step("6", "Revoked: refused on Celo, and the mirror shows it revoked", async (s) => {
    const grant = S.sessionA;
    must(!!grant, "step 3 produced no session");
    await noteBalance(s);
    const revoke = await client.revokeSession({
      wallet: S.wallet!,
      signer: S.signer!,
      session: grant as unknown as Session,
      onStatus: (status, detail) => console.log(`      ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}`),
    });
    for (const leg of revoke.legs) {
      tx(
        s,
        `revoke ${leg.kind} on chain ${leg.chainId}`,
        leg.transactionHash as Hex | undefined,
        leg.chainId === sepolia.chainId ? "sepolia" : "celo",
      );
    }
    must(revoke.status === "revoked", `revokeSession came back ${revoke.status}`);
    note(s, "revoked on the Celo account and in the Sepolia KeyStore");

    // The account must refuse it now.
    const after = await runExecute({
      session: grant as unknown as Session,
      chainId: celo.chainId,
      calls: sendProbe(funder.address),
    });
    must(!after.ok, `the revoked key still executed: ${after.hash}`);
    note(s, `the revoked key is refused on Celo (${after.status})`);

    // And the mirror, after the next anchor.
    const caches = await revoke.cacheSync;
    const leg = caches.find((l) => l.chainId === celo.chainId);
    tx(s, "revocation proof into the Celo mirror", leg?.transactionHash as Hex | undefined);
    must(leg?.status === "CONFIRMED", `the revocation proof came back ${leg?.status}: ${leg?.reason ?? ""}`);
    let cached = await readCachedKey(pub, CACHE, S.wallet!.address, grant!.keyId);
    for (let i = 0; i < 20 && !cached.revoked; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      cached = await readCachedKey(pub, CACHE, S.wallet!.address, grant!.keyId);
    }
    must(cached.revoked, "the mirror still reports the key as not revoked");
    note(s, `the Celo mirror reports revoked=true, proven from Sepolia block ${cached.sourceBlockNumber}`);
  });
}

// ---------------------------------------------------------------------------
// Refund, report
// ---------------------------------------------------------------------------

/**
 * Everything back to the funder. A relayed sweep is tried first and an EOA
 * transfer second, because the relay refuses to quote a sweep that leaves the
 * wallet unable to pay the fee ("quote has asset deficits"), and a delegated
 * wallet's admin key is an ordinary EOA key.
 */
async function refund() {
  console.log("\n[refund] return everything to the funder");
  let returned = 0n;
  for (const w of wallets) {
    const signer = signerFromPrivateKey(w.key);
    // Tokens first: a relayed call needs the wallet to still hold its fee.
    if (S.usdc) {
      const usdcAddress = S.usdc.address as Address;
      const decimals = S.usdc.decimals;
      // Three things this got wrong before, each of which stranded the token
      // in a wallet with no CELO to pay a second attempt with:
      //
      //   - calldata built by string concatenation rather than viem's
      //     encoder, which threw;
      //   - sending the WHOLE balance, which leaves nothing to pay the fee
      //     in, and the relay answers "quote has asset deficits";
      //   - reading the balance once, straight after the fee was charged, and
      //     quoting a sweep against a balance the wallet no longer had. The
      //     relay answered "quote has asset deficits" to that too, which reads
      //     like the same bug and is not: the arithmetic was right and the
      //     input was stale.
      //
      // So: a settled balance, quote the transfer in the token, send what the
      // fee leaves, and if the relay still refuses, read again and keep more
      // back — a sweep that returns a little is worth more than one that
      // returns nothing.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const held = await erc20BalanceSettled(usdcAddress, w.address);
        if (held === 0n) break;
        const quote = await client
          .quoteExecute({
            wallet: { address: w.address },
            signer,
            feeToken: usdcAddress,
            calls: {
              to: usdcAddress,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [funder.address, 1n] }),
              value: 0n,
            },
          })
          .catch(() => undefined);
        // 1.2x the quoted fee on the first try, 1.5x on the second: the quote
        // is honest about the fee and silent about the headroom the relay
        // wants on top of it.
        const margin = attempt === 1 ? 12n : 15n;
        const quoted =
          quote && quote.feeToken.toLowerCase() === usdcAddress.toLowerCase() ? quote.fee : undefined;
        const reserve = quoted !== undefined ? (quoted * margin) / 10n : held / 2n;
        const send = held > reserve ? held - reserve : 0n;
        if (send === 0n) {
          console.log(
            `    ${w.what}: ${formatUnits(held, decimals)} USDC left, below the ` +
              `${formatUnits(reserve, decimals)} the fee needs`,
          );
          break;
        }
        // Only sweep when the sweep is worth its own fee. The relay charges
        // the fee in the same token it is returning, so on a balance this
        // size it costs more than it recovers — the run that proved the sweep
        // works spent 0.265 USDC to return 0.032. The shared-wallet rule
        // takes either outcome: funds back to the funder, or the key saved to
        // the funder file so someone can take them later. When the sweep is a
        // losing trade, the key is the better half of that rule.
        //
        // Without a quote there is no price, and an unpriced sweep of a
        // wallet holding no native token is the one that strands it.
        if (quoted === undefined || send <= quoted) {
          console.log(
            `    ${w.what}: left ${formatUnits(held, decimals)} USDC in the wallet — ` +
              (quoted === undefined
                ? "the relay would not quote the sweep"
                : `a sweep returns ${formatUnits(send, decimals)} and costs up to ` +
                  `${formatUnits(quoted, decimals)}`) +
              "; its key is in the funder file",
          );
          break;
        }
        const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [funder.address, send] });
        const r = await runExecute({
          wallet: { address: w.address },
          signer,
          // The wallet holds no CELO, so the relay has to charge this in the
          // token itself; naming it leaves nothing to chance.
          feeToken: usdcAddress,
          calls: { to: usdcAddress, data, value: 0n },
        });
        console.log(
          `    ${w.what}: ${formatUnits(send, decimals)} USDC back of ${formatUnits(held, decimals)} ` +
            `(${r.status}, ${formatUnits(reserve, decimals)} kept for the fee)` +
            (r.ok ? "" : ` — ${JSON.stringify(r.raw)}`),
        );
        if (r.ok) {
          // What the sweep cost, measured rather than quoted. The reserve is
          // 1.2x the QUOTED fee and the relay charges less than it quotes, so
          // a sweep leaves a remainder every time; say how much, so nobody has
          // to reconstruct it from two explorer pages.
          const left = await erc20BalanceSettled(usdcAddress, w.address, (v) => v < held);
          console.log(
            `    ${w.what}: it cost ${formatUnits(held - send - left, decimals)} USDC to return ` +
              `${formatUnits(send, decimals)}, and ${formatUnits(left, decimals)} stays in the wallet; ` +
              "its key is in the funder file",
          );
          break;
        }
        if (attempt === 2) console.log(`    ${w.what}: left the USDC in the wallet; its key is in the funder file`);
      }
    }
    let bal = 0n;
    for (let i = 0; i < 3; i++) {
      bal = await pub.getBalance({ address: w.address });
      if (bal > 0n) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (bal === 0n) continue;
    const account = privateKeyToAccount(w.key);
    const fees = await pub.estimateFeesPerGas();
    const gasCost = 21000n * ((fees.maxFeePerGas ?? 0n) + (fees.maxPriorityFeePerGas ?? 0n));
    if (bal <= gasCost * 3n) {
      console.log(`    ${w.what}: ${formatEther(bal)} CELO left, below its own gas cost`);
      continue;
    }
    const value = bal - gasCost * 3n;
    try {
      const sweep = createWalletClient({ account, chain: celoSepolia, transport: http(celoRpc) });
      const hash = await sweep.sendTransaction({ to: funder.address, value, gas: 21000n, account, chain: celoSepolia });
      await pub.waitForTransactionReceipt({ hash });
      returned += value;
      console.log(`    ${w.what}: ${formatEther(value)} CELO back`);
    } catch (e) {
      console.log(`    ${w.what}: sweep failed — ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.log(`    returned ${formatEther(returned)} CELO in total`);
  return returned;
}

function table(): string {
  const rows = steps.map((s) => {
    const links = s.txs
      .map((t) => `[\`${t.hash.slice(0, 10)}…\`](${(t.chain === "celo" ? EXPLORER : L1_EXPLORER)}/tx/${t.hash})`)
      .join(" ");
    return `| ${s.id} | ${s.title} | **${s.status}** | ${s.seconds ?? "-"}s | ${links} |`;
  });
  return [
    "| Step | What it proves | Result | Took | Transactions |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function writeReport(kind: "partial" | "final") {
  const passed = steps.filter((s) => s.status === "PASS").length;
  const failed = steps.filter((s) => s.status === "FAIL").length;
  const verdict = failed === 0 && kind === "final" ? "PASS" : failed > 0 ? "FAIL" : "PARTIAL";
  const lines: string[] = [];
  lines.push(`# Celo acceptance run, ${startedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`**Verdict: ${verdict}** — ${passed} of ${steps.length} steps passed${failed ? `, ${failed} failed` : ""}.`);
  lines.push("");
  lines.push(`- SDK build: \`${sdkBuild.describe}\`${sdkBuild.dirty ? " (DIRTY)" : ""}, built ${sdkBuild.builtAt}`);
  lines.push(`- Relay: ${RELAY}`);
  lines.push(`- Mirror (KeyStoreCache): \`${CACHE}\``);
  lines.push(`- Started ${startedAt}`);
  lines.push(
    `- Relay calls: ${wire.length}, of which ${wire.filter((w) => w.method === "wallet_prepareCalls").length} prepares`,
  );
  lines.push("");
  lines.push(table());
  lines.push("");
  for (const s of steps) {
    lines.push(`## ${s.id} — ${s.title}`);
    lines.push("");
    lines.push(`**${s.status}**${s.seconds ? ` in ${s.seconds}s` : ""}`);
    lines.push("");
    for (const d of s.detail) lines.push(`- ${d}`);
    for (const t of s.txs) {
      const base = t.chain === "celo" ? EXPLORER : L1_EXPLORER;
      lines.push(`- ${t.what}: [\`${t.hash}\`](${base}/tx/${t.hash})`);
    }
    lines.push("");
  }
  const path = `${EVIDENCE_DIR}/${startedAt.slice(0, 10)}-acceptance.md`;
  try {
    writeFileSync(path, `${lines.join("\n")}\n`);
    writeFileSync(
      `${EVIDENCE_DIR}/${startedAt.slice(0, 10)}-acceptance-run.json`,
      `${JSON.stringify({ verdict, sdkBuild: sdkBuild.describe, relay: RELAY, startedAt, steps }, null, 2)}\n`,
    );
    if (kind === "final") console.log(`\nreport: ${path}`);
  } catch (e) {
    console.log(`could not write ${path}: ${(e as Error).message}`);
  }
  return verdict;
}

main()
  .catch((e) => {
    console.error(`\nthe run stopped: ${(e as Error).message}`);
    steps.push({ id: "-", title: "the run stopped before finishing", status: "FAIL", detail: [String(e)], txs: [] });
  })
  .finally(async () => {
    await refund().catch((e) => console.log(`refund failed: ${(e as Error).message}`));
    const verdict = writeReport("final");
    console.log("\n=================================================");
    console.log(table());
    console.log(`\nVerdict: ${verdict}`);
    process.exitCode = verdict === "PASS" ? 0 : 1;
  });
