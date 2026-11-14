/**
 * The live proof for Celo: grant a session, use it, register it, mirror it,
 * revoke it, from a wallet that holds nothing on the KeyStore chain.
 *
 * Two wallets, one per run (`--wallet celo` or `--wallet usdc`): one holds
 * CELO only, the other USDC only and no CELO at all.
 *
 * With `--send`, in order:
 *
 *   1. grant     `grantSession({ wallet, signer, permissions, expiry, chainId })`
 *                with the SDK's defaults: no `l1Client`, no fee token.
 *   2. execute   straight after the grant returns, the session sends about one
 *                cent of the wallet's own token to `--send-cent-to`.
 *   3. register  `registration` resolves; the key is valid in the KeyStore on
 *                the registry chain (Ethereum, or Sepolia on the testnet).
 *   4. mirror    `cacheSync` resolves (15 to 30 minutes); the key is in the
 *                KeyStoreCache on Celo.
 *   5. charge    what the wallet was charged for the grant, leg by leg, in its
 *                own token and in dollars at the Chainlink price of the time;
 *                and what it locked for the registry write against what the
 *                relay's funder fronted. Everything is read from the chains.
 *   6. revoke    the key is gone from the account and invalid in the KeyStore;
 *                then the cache shows it revoked.
 *
 * Nothing is swept: what is left stays in the wallet, unless `--sweep-to`
 * names an address. The session lasts 24 hours and may make only the one-cent
 * transfer, so one that could not be revoked is harmless.
 *
 * A step the wallet cannot pay for is an outcome, not a crash: it is reported
 * as "not run: insufficient funds" with the SDK's own sentence, and the run
 * goes on to what can still be done and to the summary.
 *
 * WITHOUT `--send` THIS IS A DRY RUN: it reads, prints and checks, and signs
 * and sends nothing. On `--network celo` a send also needs `--i-am-doris` and
 * a phrase typed at an interactive terminal: it spends real funds, and only
 * the owner runs it.
 *
 * Keys come from the environment, or from the env file beside the repository
 * (`.env.mainnet`, `.env.testnet`), and are never printed:
 *   celo          MAINNET_TEST_CELO_KEY, MAINNET_TEST_USDC_KEY (and
 *                 CELO_MAINNET_RPC_URL for this script's own reads)
 *   celo-sepolia  two throwaway keys, created on the first `--send`, saved to
 *                 the shared testnet env file before they are funded from
 *                 TEST_FUNDER_KEY
 *
 * A run that stops part way is continued with `--resume`: the session key is
 * kept beside the JSON record (mode 600), and the wallet goes on from its
 * first step not done instead of granting again.
 *
 * Run (from tests/e2e):
 *   bun run live:celo-proof -- --network celo-sepolia
 *   bun run live:celo-proof -- --network celo-sepolia --wallet usdc --send
 */
import {
  CELO,
  CELO_SEPOLIA,
  SessionRevokeError,
  altanaErrorOf,
  createClient,
  deserializeSession,
  formatQuoteLine,
  getKeys,
  isCachedKeyValid,
  keyHashForSessionOrKey,
  keyIdForSessionOrKey,
  keyStoreCacheOf,
  networkByChainId,
  readCachedKey,
  readL1Anchor,
  registryNetwork,
  sdkBuild,
  serializeSession,
  signerFromPrivateKey,
  type GrantSessionResult,
  type NetworkConfig,
  type SerializedSession,
  type Session,
  type SessionLeg,
  type SessionPermissions,
  type SessionQuote,
  type Signer,
} from "@altananetwork/sdk";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatGwei,
  formatUnits,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  EXPECTED,
  MAINNET_CENT_RECIPIENT,
  MAINNET_PHRASE,
  USAGE,
  UsageError,
  assertCanConfirm,
  assertCentRecipient,
  assertIdentity,
  chargeReport,
  convert,
  decodeIntents,
  describeError,
  estimateRegistration,
  firstStepNotDone,
  isConfirmed,
  isInsufficientFunds,
  oneCentIn,
  overBps,
  parseProofArgs,
  redact,
  stepsFor,
  summaryTable,
  sweepAmount,
  usdText as dollars,
  usdValue,
  type DescribedError,
  type IntentMoney,
  type ProofOptions,
  type RegistryWrite,
  type Role,
  type Step,
  type StepStatus,
  type SummaryRow,
  type UsdPrice,
} from "./celo-proof-lib.js";
import { describeLeg } from "./session-legs.js";
import { testnetEnvFile } from "./testnet-env.js";

// ── What to run, and on which network. Checked before anything is read. ─────

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

let opts: ProofOptions;
try {
  opts = parseProofArgs(process.argv.slice(2));
  assertCanConfirm(opts, process.stdin.isTTY === true);
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`${err.message}\n\n${USAGE}`);
  process.exit(2);
}

const sdkNetwork: NetworkConfig = opts.network === "celo" ? CELO : CELO_SEPOLIA;
const sdkRegistry: NetworkConfig = registryNetwork(sdkNetwork);
assertIdentity(opts.network, {
  chainId: sdkNetwork.chainId,
  ...(sdkNetwork.relayUrl ? { relayUrl: sdkNetwork.relayUrl } : {}),
  registryChainId: sdkRegistry.chainId,
});
const MAINNET = opts.network === "celo";
const RELAY_URL = sdkNetwork.relayUrl!;
const CHAIN_ID = sdkNetwork.chainId;
const CACHE = keyStoreCacheOf(sdkNetwork);
const HERE = dirname(fileURLToPath(import.meta.url));

/** USDC on Celo, the token the mainnet relay lists. Checked against the relay's own answer. */
const MAINNET_USDC: Address = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
/** Chainlink USDC/USD on Celo, which the mainnet relay prices USDC from. */
const MAINNET_USDC_USD_FEED: Address = "0xc7A353BaE210aed958a1A2928b654938EC59DaB2";

/**
 * Loads the env file beside the repository for whatever is not in the
 * environment already: `.env.mainnet` or `.env.testnet`, the nearest one at or
 * above this directory (or the file `MAINNET_ENV_FILE` / `TESTNET_ENV_FILE`
 * names). Values already set win. Nothing read here is printed.
 */
function loadEnvFile(): string | undefined {
  let file: string | undefined;
  if (MAINNET) {
    file = process.env.MAINNET_ENV_FILE;
    for (let dir = HERE; !file; dir = dirname(dir)) {
      if (existsSync(join(dir, ".env.mainnet"))) file = join(dir, ".env.mainnet");
      if (dirname(dir) === dir) break;
    }
  } else {
    try {
      file = testnetEnvFile();
    } catch {
      file = undefined;
    }
  }
  if (!file || !existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    // The last line for a name wins, as it does when a shell sources the file.
    if (fromShell.has(name)) continue;
    process.env[name] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return file;
}
const fromShell = new Set(Object.keys(process.env));
const ENV_FILE = loadEnvFile();

const ENV = MAINNET
  ? { celoRpc: "CELO_MAINNET_RPC_URL", registryRpc: "ETHEREUM_RPC_URL", celoKey: "MAINNET_TEST_CELO_KEY", usdcKey: "MAINNET_TEST_USDC_KEY" }
  : { celoRpc: "CELO_SEPOLIA_RPC_URL", registryRpc: "SEPOLIA_RPC_URL", celoKey: "CELOPROOF_CELO_KEY", usdcKey: "CELOPROOF_USDC_KEY" };

const envCeloRpc = process.env[ENV.celoRpc] || undefined;
const envRegistryRpc = process.env[ENV.registryRpc] || undefined;

/** The networks this script reads through: the environment's RPCs where it has them. */
const celoRead: NetworkConfig = envCeloRpc ? { ...sdkNetwork, publicRpcUrl: envCeloRpc } : sdkNetwork;
const registryRead: NetworkConfig = envRegistryRpc ? { ...sdkRegistry, publicRpcUrl: envRegistryRpc } : sdkRegistry;
/** The network the SDK client is created with: the SDK's own constant unless `--client-rpc env`. */
const clientNetwork: NetworkConfig =
  opts.clientRpc === "env"
    ? { ...celoRead, registry: { kind: "cached", l1: registryRead, keyStoreCache: CACHE } }
    : sdkNetwork;
const clientRegistry = registryNetwork(clientNetwork);

const celoPub = createPublicClient({ chain: sdkNetwork.chain, transport: http(celoRead.publicRpcUrl) }) as PublicClient;
const regPub = createPublicClient({ chain: sdkRegistry.chain, transport: http(registryRead.publicRpcUrl) }) as PublicClient;

const OUT_DIR = opts.outDir ?? join(HERE, ".out");
const RECORD_FILE = join(OUT_DIR, `celo-proof-${opts.network}-${opts.send ? opts.wallet : "dry-run"}.json`);
const sessionFile = (role: Role) => join(OUT_DIR, `celo-proof-${opts.network}-${role}.session.json`);
const NATIVE = sdkRegistry.chain.nativeCurrency.symbol;

// ── Small tools ─────────────────────────────────────────────────────────────

/** Values that must never reach the terminal or the record. Keys are added as they are read. */
const secrets: (string | undefined)[] = [envCeloRpc, envRegistryRpc, process.env.TEST_FUNDER_KEY];
const clean = (text: unknown) => redact(String(text), secrets);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const txLink = (n: NetworkConfig, hash?: Hex | null) => (hash ? `${n.explorer}/tx/${hash}` : "");
const lower = (a: string) => a.toLowerCase();
const isNative = (a: Address) => /^0x0{40}$/.test(a);
const jsonSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

let failed = 0;
let warnings = 0;
function check(prefix: string, ok: boolean, what: string): boolean {
  console.log(`${prefix}${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
  return ok;
}
function warn(prefix: string, what: string): void {
  console.log(`${prefix}WARN ${what}`);
  warnings++;
}
const info = (prefix: string, what: string) => console.log(`${prefix}     ${what}`);

/** Polls a read until it holds: a public RPC can trail the relay by a few seconds. */
async function eventually(read: () => Promise<boolean>, timeoutMs = 90_000): Promise<boolean> {
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

async function relayRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`the relay answered HTTP ${res.status} to ${method}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error || body.result === undefined) throw new Error(`the relay refused ${method}: ${body.error?.message ?? "no result"}`);
  return body.result;
}

// ── Contracts read directly ─────────────────────────────────────────────────

const KEYSTORE_ABI = parseAbi([
  "function isValidKey(address user, bytes32 keyId) view returns (bool)",
  "function getKeys(address user) view returns (bytes32[])",
]);
const CONTROLLER_ABI = parseAbi(["function getRegistrationFeeInWei() view returns (uint256)"]);
const CACHE_ABI = parseAbi(["function VERSION() view returns (string)", "function l1KeyStore() view returns (address)"]);
const ESCROW_ABI = parseAbi([
  "event EscrowCreated(bytes32 escrowId)",
  "function escrows(bytes32) view returns (bytes12 salt, address depositor, address recipient, address token, uint256 escrowAmount, uint256 refundAmount, uint256 refundTimestamp, address settler, address sender, bytes32 settlementId, uint256 senderChainId)",
  "function statuses(bytes32) view returns (uint8)",
]);
const ESCROW_STATUS = ["NULL", "CREATED", "REFUND_DEPOSIT", "REFUND_RECIPIENT", "FINALIZED"];
const AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

const isValidKey = (wallet: Address, keyId: Hex) =>
  regPub.readContract({ address: sdkRegistry.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [wallet, keyId] });

/** True when the account on Celo holds the key. False when the address has no account code yet. */
async function accountHolds(wallet: Address, keyHash: Hex): Promise<boolean> {
  const code = await celoPub.getCode({ address: wallet });
  if (!code || code === "0x") return false;
  return (await getKeys(celoPub, wallet)).keyHashes.includes(keyHash);
}

// ── Prices ──────────────────────────────────────────────────────────────────

type Feed = { label: string; address: Address; client: PublicClient; maxAgeSecs?: number };
type FeedReading = {
  price: UsdPrice;
  updatedAt: bigint;
  description: string;
  /** The answer before this one, when the feed still serves it. */
  previous?: { price: UsdPrice; updatedAt: bigint };
};

function feedOf(network: NetworkConfig, label: string): Feed | undefined {
  const f = network.nativePriceFeed;
  if (!f) return undefined;
  // The feed is not always on the chain it prices: the testnet relay prices CELO from the feed on Celo.
  const client =
    f.chain.id === sdkNetwork.chainId
      ? celoPub
      : f.chain.id === sdkRegistry.chainId
        ? regPub
        : (createPublicClient({ chain: f.chain, transport: http(f.publicRpcUrl) }) as PublicClient);
  return { label, address: f.address, client, maxAgeSecs: f.maxAgeSecs };
}

const nativeFeed = feedOf(sdkRegistry, `${NATIVE}/USD`);
const celoFeed = feedOf(sdkNetwork, "CELO/USD");
const usdcFeed: Feed | undefined = MAINNET
  ? { label: "USDC/USD", address: MAINNET_USDC_USD_FEED, client: celoPub, maxAgeSecs: celoFeed?.maxAgeSecs }
  : undefined;

/**
 * A feed's answer: the newest one, or the one that was current at `at` (unix
 * seconds). An aggregator keeps its past rounds, so the price a charge was
 * made at can be read back later without an archive node.
 */
async function readFeed(feed: Feed, at?: bigint): Promise<FeedReading> {
  const [latest, decimals, description] = await Promise.all([
    feed.client.readContract({ address: feed.address, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
    feed.client.readContract({ address: feed.address, abi: AGGREGATOR_ABI, functionName: "decimals" }),
    feed.client.readContract({ address: feed.address, abi: AGGREGATOR_ABI, functionName: "description" }),
  ]);
  let [roundId, answer, , updatedAt] = latest;
  for (let back = 0; at !== undefined && updatedAt > at && back < 200; back++) {
    try {
      const prev = await feed.client.readContract({
        address: feed.address,
        abi: AGGREGATOR_ABI,
        functionName: "getRoundData",
        args: [roundId - 1n],
      });
      if (prev[3] === 0n) break;
      [roundId, answer, , updatedAt] = prev;
    } catch {
      break;
    }
  }
  if (answer <= 0n) throw new Error(`the ${feed.label} feed answered ${answer}`);
  let previous: FeedReading["previous"];
  try {
    const prev = await feed.client.readContract({ address: feed.address, abi: AGGREGATOR_ABI, functionName: "getRoundData", args: [roundId - 1n] });
    if (prev[1] > 0n && prev[3] > 0n) previous = { price: { answer: prev[1], decimals }, updatedAt: prev[3] };
  } catch {
    // The first round of a feed has none before it.
  }
  return { price: { answer, decimals }, updatedAt, description, ...(previous ? { previous } : {}) };
}

const priceText = (p: UsdPrice) => `$${formatUnits(p.answer, p.decimals)}`;
const ONE_DOLLAR: UsdPrice = { answer: 100_000_000n, decimals: 8 };

// ── The record ──────────────────────────────────────────────────────────────

type WalletRecord = {
  role: Role;
  address: Address;
  token: string;
  grantStartedAt?: string;
  steps: Partial<Record<Step, StepStatus>>;
  rows: SummaryRow[];
  data: Record<string, unknown>;
  error?: DescribedError & { step: string };
};

const record: {
  network: string;
  chainId: number;
  registryChainId: number;
  relay: string;
  sdk: string;
  mode: "dry-run" | "send";
  startedAt: string;
  finishedAt?: string;
  sdkClientRpc: string;
  preconditions: Record<string, unknown>;
  wallets: Partial<Record<Role, WalletRecord>>;
} = {
  network: opts.network,
  chainId: CHAIN_ID,
  registryChainId: sdkRegistry.chainId,
  relay: RELAY_URL,
  sdk: sdkBuild.describe,
  mode: opts.send ? "send" : "dry-run",
  startedAt: new Date().toISOString(),
  sdkClientRpc: opts.clientRpc,
  preconditions: {},
  wallets: {},
};

function saveRecord(): void {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(RECORD_FILE, clean(JSON.stringify(record, jsonSafe, 2)));
}

function loadPreviousRecord(): typeof record | undefined {
  try {
    return JSON.parse(readFileSync(RECORD_FILE, "utf8")) as typeof record;
  } catch {
    return undefined;
  }
}

/** The session an earlier run left for a wallet. Holds the session's private key: mode 600, never printed. */
type SessionFile = {
  network: string;
  role: Role;
  wallet: Address;
  sessionPrivateKey: Hex;
  publicKey: Hex;
  /** Set once the grant returned: what `deserializeSession` needs. */
  session?: SerializedSession;
  createdAt: string;
};

function readSessionFile(role: Role): SessionFile | undefined {
  const file = sessionFile(role);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionFile;
  secrets.push(parsed.sessionPrivateKey);
  return parsed;
}

function writeSessionFile(s: SessionFile): void {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const file = sessionFile(s.role);
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

// ── Wallets ─────────────────────────────────────────────────────────────────

type Token = { symbol: string; decimals: number; address: Address };

type Ctx = {
  role: Role;
  prefix: string;
  admin: Signer;
  adminKey: Hex;
  wallet: { address: Address };
  /** The token this wallet holds and pays in. */
  token: Token;
  rec: WalletRecord;
  /** When this wallet's grant started, in epoch milliseconds. */
  t0: number;
  session?: Session;
  /** Set when the grant ran in this process. */
  granted?: GrantSessionResult;
  revokeCacheSync?: Promise<SessionLeg[]>;
  /** Steps that cannot run because one they depend on did not, with why. */
  blocked: Map<Step, string>;
};

/** The last `NAME=value` in the shared testnet env file, so a key saved by an earlier run is found without re-sourcing. */
function savedTestnetKey(name: string): Hex | undefined {
  let found: string | undefined = process.env[name];
  try {
    for (const line of readFileSync(testnetEnvFile(), "utf8").split("\n")) {
      if (line.startsWith(`${name}=`)) found = line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No shared env file: the environment variable, if any, is all there is.
  }
  return found && /^0x[0-9a-fA-F]{64}$/.test(found) ? (found as Hex) : undefined;
}

/** The two admin keys. On the testnet they are made here and saved before anything is sent to them. */
function adminKeys(): { keys: Record<Role, Hex>; note: Record<Role, string> } {
  const keys = {} as Record<Role, Hex>;
  const note = {} as Record<Role, string>;
  for (const role of ["celo", "usdc"] as const) {
    const name = role === "celo" ? ENV.celoKey : ENV.usdcKey;
    if (MAINNET) {
      const key = process.env[name];
      if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error(`${name} is not set, and no .env.mainnet was found beside the repository. Set MAINNET_ENV_FILE to the file, or load it: set -a; source <file>; set +a`);
      }
      keys[role] = key as Hex;
      note[role] = `from ${name}`;
      const stated = process.env[name.replace(/_KEY$/, "_ADDRESS")];
      const derived = privateKeyToAccount(keys[role]).address;
      if (stated && lower(stated) !== lower(derived)) {
        throw new Error(`${name} does not belong to ${name.replace(/_KEY$/, "_ADDRESS")} (${stated}); it is the key of ${derived}.`);
      }
    } else {
      const saved = opts.fresh && opts.wallet === role ? undefined : savedTestnetKey(name);
      if (saved) {
        keys[role] = saved;
        note[role] = `throwaway, saved as ${name}`;
      } else if (opts.send && opts.wallet === role) {
        const key = generatePrivateKey();
        const address = privateKeyToAccount(key).address;
        appendFileSync(
          testnetEnvFile(),
          `\n# live-celo-proof ${role} wallet ${address}, ${new Date().toISOString()}\n` +
            `${name}=${key}\nCELOPROOF_${address.slice(2, 10).toUpperCase()}_KEY=${key}\n`,
        );
        keys[role] = key;
        note[role] = `new throwaway, saved as ${name} before funding`;
      } else {
        keys[role] = generatePrivateKey();
        note[role] = "a throwaway for this run's display only; --send makes and saves the real one";
      }
    }
    secrets.push(keys[role]);
  }
  return { keys, note };
}

type Capabilities = {
  contracts?: Record<string, { address?: Address } | unknown>;
  fees?: {
    recipient?: Address;
    quoteConfig?: { ttl?: number; rateTtl?: number; gas?: { intentBuffer?: number; txBuffer?: number } };
    tokens?: { uid?: string; address: Address; decimals: number; symbol?: string; feeToken?: boolean }[];
  };
};

type Facts = {
  usdc: Token;
  celo: Token;
  escrow: Address;
  funder: Address;
  registrationFee: bigint;
  /** The registry chain's base fee and suggested tip, in wei. */
  baseFee: bigint;
  tip: bigint;
  /** How long before a charge the relay may have read its prices: its rate cache plus a quote's life. */
  priceWindowSecs: number;
  prices: { native: FeedReading; celo: FeedReading; usdc: FeedReading };
};

async function tokenBalance(token: Token, owner: Address): Promise<bigint> {
  if (isNative(token.address)) return celoPub.getBalance({ address: owner });
  return celoPub.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

const amountText = (v: bigint, t: Token) => `${formatUnits(v, t.decimals)} ${t.symbol}`;
const tokenPrice = (role: Role, facts: Facts) => (role === "celo" ? facts.prices.celo.price : facts.prices.usdc.price);

// ── Preconditions: read, print, judge. Signs nothing. ───────────────────────

async function relayAndChainChecks(): Promise<Facts> {
  const p = "    ";
  console.log("\n[relay and chains]");
  // The chain id the RPC itself reports, before any other read.
  const [celoId, registryId] = await Promise.all([celoPub.getChainId(), regPub.getChainId()]);
  if (celoId !== EXPECTED[opts.network].chainId || registryId !== EXPECTED[opts.network].registryChainId) {
    throw new Error(
      `The RPCs are not the chains this run is for: Celo side reports ${celoId} (want ${EXPECTED[opts.network].chainId}), ` +
        `registry side ${registryId} (want ${EXPECTED[opts.network].registryChainId}). Nothing was done.`,
    );
  }
  check(p, true, `the RPCs report chain ${celoId} and registry chain ${registryId}`);

  const health = await relayRpc<{ status?: string; version?: string }>("health", []);
  check(p, health.status === "rpc ok", `relay ${RELAY_URL} is healthy (${health.status}, version ${health.version})`);
  const caps = await relayRpc<Record<string, Capabilities>>("wallet_getCapabilities", [[CHAIN_ID, sdkRegistry.chainId]]);
  const capOf = (id: number) => caps[`0x${id.toString(16)}`] ?? caps[String(id)];
  const celoCaps = capOf(CHAIN_ID);
  check(p, celoCaps !== undefined, `the relay serves ${sdkNetwork.chain.name} (${CHAIN_ID})`);
  check(p, capOf(sdkRegistry.chainId) !== undefined, `the relay serves the registry chain ${sdkRegistry.chain.name} (${sdkRegistry.chainId})`);
  if (!celoCaps) throw new Error("The relay does not serve this chain; nothing more can be checked.");

  const tokens = celoCaps.fees?.tokens ?? [];
  const nativeToken = tokens.find((t) => isNative(t.address) && t.feeToken);
  const usdcToken = tokens.find((t) => t.uid === "usdc" && t.feeToken);
  check(p, nativeToken !== undefined, "the relay takes its fee in CELO");
  check(p, usdcToken !== undefined, `the relay takes its fee in USDC${usdcToken ? ` (${usdcToken.address})` : ""}`);
  if (MAINNET && usdcToken) {
    check(p, lower(usdcToken.address) === lower(MAINNET_USDC), `that USDC is Celo's USDC ${MAINNET_USDC}`);
  }
  if (!usdcToken) throw new Error("The relay lists no USDC fee token; the USDC wallet cannot run.");
  const address = (name: string) => (celoCaps.contracts?.[name] as { address?: Address } | undefined)?.address;
  const escrow = address("escrow");
  const funder = address("funder");
  check(p, !!escrow && !!funder, `the relay names its escrow ${escrow} and its funder ${funder}`);
  if (!escrow || !funder) throw new Error("The relay did not name its escrow and funder.");
  const quoteConfig = celoCaps.fees?.quoteConfig;
  info(p, `quotes last ${quoteConfig?.ttl ?? "?"}s; gas buffers ${JSON.stringify(quoteConfig?.gas ?? {})}; fees go to ${celoCaps.fees?.recipient}`);

  console.log("\n[KeyStoreCache on Celo]");
  const code = await celoPub.getCode({ address: CACHE });
  check(p, !!code && code !== "0x", `${CACHE} has code (${code ? (code.length - 2) / 2 : 0} bytes)`);
  let version = "";
  try {
    version = await celoPub.readContract({ address: CACHE, abi: CACHE_ABI, functionName: "VERSION" });
  } catch (err) {
    info(p, `VERSION() could not be read: ${clean((err as Error).message).split("\n")[0]}`);
  }
  check(p, version !== "", `VERSION() is ${JSON.stringify(version)}`);
  try {
    const l1 = await celoPub.readContract({ address: CACHE, abi: CACHE_ABI, functionName: "l1KeyStore" });
    check(p, lower(l1) === lower(sdkRegistry.keyStore), `it is anchored to the KeyStore ${l1} on ${sdkRegistry.chain.name}`);
  } catch {
    info(p, "l1KeyStore() could not be read");
  }

  console.log(`\n[registry chain: ${sdkRegistry.chain.name}]`);
  const [block, tipRead, registrationFee] = await Promise.all([
    regPub.getBlock({ blockTag: "latest" }),
    regPub.estimateMaxPriorityFeePerGas().catch(() => undefined),
    regPub.readContract({ address: sdkRegistry.keyStoreController, abi: CONTROLLER_ABI, functionName: "getRegistrationFeeInWei" }),
  ]);
  const baseFee = block.baseFeePerGas ?? 0n;
  const tip = tipRead ?? 0n;
  info(p, `gas price now: base fee ${formatGwei(baseFee)} gwei, suggested tip ${tipRead === undefined ? "?" : formatGwei(tip)} gwei (block ${block.number})`);

  // The proof into the cache is built against the registry-chain block Celo anchors, some way behind head.
  const proofUrls = clientRegistry.proofRpcUrls ?? [clientRegistry.publicRpcUrl];
  try {
    const anchor = await readL1Anchor(celoPub);
    const serving: string[] = [];
    await Promise.all(
      proofUrls.map(async (url) => {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getProof", params: [sdkRegistry.keyStore, [], `0x${anchor.number.toString(16)}`] }),
            signal: AbortSignal.timeout(15_000),
          });
          const body = (await res.json()) as { result?: { storageHash?: string } };
          if (body.result?.storageHash) serving.push(url);
        } catch {
          // An endpoint that does not answer is simply not counted.
        }
      }),
    );
    check(
      p,
      serving.length > 0,
      `Celo anchors block ${anchor.number} (${(block.number ?? 0n) - anchor.number} behind head); ` +
        `${serving.length} of the SDK's ${proofUrls.length} proof RPC(s) serve eth_getProof there`,
    );
    record.preconditions.proofRpcs = { anchored: anchor.number, behindHead: (block.number ?? 0n) - anchor.number, serving: serving.map(clean), of: proofUrls.length };
  } catch (err) {
    check(p, false, `the registry-chain anchor could not be read: ${clean((err as Error).message).split("\n")[0]}`);
  }

  console.log("\n[prices the relay converts at]");
  if (!nativeFeed || !celoFeed) throw new Error("The SDK config names no price feed for this network.");
  const [nativePrice, celoPrice, usdcPrice] = await Promise.all([
    readFeed(nativeFeed),
    readFeed(celoFeed),
    usdcFeed ? readFeed(usdcFeed) : Promise.resolve<FeedReading>({ price: ONE_DOLLAR, updatedAt: 0n, description: "taken as $1 (no feed)" }),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const [feed, reading] of [[nativeFeed, nativePrice], [celoFeed, celoPrice], ...(usdcFeed ? [[usdcFeed, usdcPrice] as const] : [])] as const) {
    const age = Number(now - reading.updatedAt);
    check(
      p,
      feed.maxAgeSecs === undefined || age <= feed.maxAgeSecs,
      `${reading.description} ${priceText(reading.price)}, ${age}s old (the relay accepts ${feed.maxAgeSecs ?? "?"}s)`,
    );
  }
  if (!usdcFeed) info(p, "USDC is taken as $1: this network has no USDC/USD feed in the script");
  info(p, `registration fee ${formatEther(registrationFee)} ${NATIVE} per key (${dollars(usdValue(registrationFee, 18, nativePrice.price))})`);

  record.preconditions.relay = { health, escrow, funder, feeRecipient: celoCaps.fees?.recipient, quoteConfig, feeTokens: tokens.map((t) => `${t.symbol ?? t.uid} ${t.address}`) };
  record.preconditions.cache = { address: CACHE, version };
  record.preconditions.registry = { baseFeeGwei: formatGwei(baseFee), tipGwei: tipRead === undefined ? null : formatGwei(tip), registrationFee };
  record.preconditions.prices = { native: priceText(nativePrice.price), celo: priceText(celoPrice.price), usdc: priceText(usdcPrice.price) };

  return {
    usdc: { symbol: "USDC", decimals: usdcToken.decimals, address: usdcToken.address },
    celo: { symbol: "CELO", decimals: 18, address: "0x0000000000000000000000000000000000000000" },
    escrow,
    funder,
    registrationFee,
    baseFee,
    tip,
    priceWindowSecs: (quoteConfig?.rateTtl ?? 300) + (quoteConfig?.ttl ?? 120) + 60,
    prices: { native: nativePrice, celo: celoPrice, usdc: usdcPrice },
  };
}

/** The transfer the session makes: about one cent of the wallet's own token. */
function centTransfer(role: Role, facts: Facts, to: Address): { amount: bigint; call: { to: Address; value: bigint; data: Hex } } {
  if (role === "celo") {
    const amount = oneCentIn(facts.prices.celo.price, 18);
    return { amount, call: { to, value: amount, data: "0x" } };
  }
  const amount = oneCentIn(facts.prices.usdc.price, facts.usdc.decimals);
  return {
    amount,
    call: { to: facts.usdc.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) },
  };
}

/**
 * The session's permissions, as narrow as its one job allows: the one call,
 * and a daily cap that covers the cent plus the relay's fee for sending it (a
 * session pays its fee from its cap).
 */
function permissionsFor(role: Role, facts: Facts, to: Address, feeHeadroom: bigint): SessionPermissions {
  const cent = centTransfer(role, facts, to).amount;
  if (role === "celo") {
    return { calls: [{ to }], spend: [{ limit: cent + feeHeadroom, period: "day" }] };
  }
  return {
    calls: [{ to: facts.usdc.address, signature: "transfer(address,uint256)" }],
    spend: [{ token: facts.usdc.address, limit: cent + feeHeadroom, period: "day" }],
  };
}

/** Fee headroom when the quote cannot say: generous on the testnet, where the relay's gas buffers are large. */
const fallbackHeadroom = (role: Role) =>
  role === "celo" ? parseEther(MAINNET ? "1" : "2") : parseUnits(MAINNET ? "0.2" : "2.5", 6);

type Quoted = { quote?: SessionQuote; permissions: SessionPermissions; accountFee?: bigint; registryPriced: boolean; registryReason?: string; error?: string };

/** `quoteGrantSession` for a wallet, and the permissions sized from it. Signs nothing. */
async function quoteFor(ctx: Pick<Ctx, "role" | "admin" | "wallet" | "token">, facts: Facts, to: Address): Promise<Quoted> {
  const client = createClient({ chains: [clientNetwork] });
  const provisional = permissionsFor(ctx.role, facts, to, fallbackHeadroom(ctx.role));
  let quote: SessionQuote;
  try {
    quote = await client.quoteGrantSession({
      wallet: ctx.wallet,
      signer: ctx.admin,
      sessionSigner: signerFromPrivateKey(generatePrivateKey()),
      permissions: provisional,
      expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
      chainId: CHAIN_ID,
    });
  } catch (err) {
    return { permissions: provisional, registryPriced: false, error: clean((err as Error).message).split("\n")[0]! };
  }
  // A session's own transaction costs no more than the authorization that grants it: three of those is room to spare.
  const account = quote.lines.find((l) => l.kind === "account" && l.chainId === CHAIN_ID);
  const sized = account?.fee !== undefined && lower(account.feeToken) === lower(ctx.token.address);
  const headroom = sized ? account!.fee! * 3n : fallbackHeadroom(ctx.role);
  const registry = quote.lines.find((l) => l.kind === "registry");
  return {
    quote,
    permissions: permissionsFor(ctx.role, facts, to, headroom),
    ...(sized ? { accountFee: account!.fee! } : {}),
    registryPriced: registry !== undefined && registry.fee !== undefined,
    ...(registry?.reason ? { registryReason: clean(registry.reason).split("\n")[0]! } : {}),
  };
}

/** What the quote says the conversion costs, against the feeds right now. Information, not a verdict. */
function quotedConversion(ctx: Pick<Ctx, "token" | "prefix" | "role">, quote: SessionQuote, facts: Facts): void {
  const line = quote.lines.find((l) => l.kind === "registry" && l.fundedFromChainId === CHAIN_ID);
  if (!line || line.fee === undefined) return;
  // One intent's own figures: on a first registration the line adds two quotes together, and the
  // root key's write is the one whose need, fees and value all describe the same intent.
  const part = line.rootRegistration ?? line;
  const onChain = (id: number) => (part.charges ?? []).filter((c) => c.chainId === id).reduce((s, c) => s + c.fee, 0n);
  const need = (part.needs ?? [])
    .filter((n) => n.chainId === CHAIN_ID && lower(n.token) === lower(ctx.token.address))
    .reduce((s, n) => s + n.amount, 0n);
  const locked = need - onChain(CHAIN_ID);
  const fronted = part.value + onChain(sdkRegistry.chainId);
  if (locked <= 0n || fronted <= 0n) return;
  const atFeeds = convert(fronted, { decimals: 18, price: facts.prices.native.price }, { decimals: ctx.token.decimals, price: tokenPrice(ctx.role, facts) });
  if (atFeeds <= 0n) return;
  const marginBps = overBps(locked, atFeeds);
  const close = Math.abs(marginBps - opts.marginBps) <= Math.max(opts.marginToleranceBps, 100);
  const text =
    `relay's quote${line.rootRegistration ? " for the root key's write" : ""}: ${amountText(locked, ctx.token)} to lock for ${formatEther(fronted)} ${NATIVE} fronted, ` +
    `${(marginBps / 100).toFixed(2)}% above the feeds (the relay's margin is ${(opts.marginBps / 100).toFixed(2)}%)`;
  if (close) info(ctx.prefix, text);
  else warn(ctx.prefix, `${text}. That is not the configured margin; look at it before sending`);
}

async function walletChecks(ctx: Ctx, facts: Facts, note: string, centTo: Address): Promise<void> {
  const p = ctx.prefix;
  console.log(`\n[${ctx.role} wallet] ${ctx.wallet.address} (${note})`);
  const [celoBalance, usdcBalance, registryBalance, celoCode, registryCode, keys] = await Promise.all([
    celoPub.getBalance({ address: ctx.wallet.address }),
    tokenBalance(facts.usdc, ctx.wallet.address),
    regPub.getBalance({ address: ctx.wallet.address }),
    celoPub.getCode({ address: ctx.wallet.address }),
    regPub.getCode({ address: ctx.wallet.address }),
    regPub.readContract({ address: sdkRegistry.keyStore, abi: KEYSTORE_ABI, functionName: "getKeys", args: [ctx.wallet.address] }),
  ]);
  const held = ctx.role === "celo" ? celoBalance : usdcBalance;
  const price = tokenPrice(ctx.role, facts);
  info(p, `holds ${formatEther(celoBalance)} CELO and ${formatUnits(usdcBalance, facts.usdc.decimals)} USDC on ${sdkNetwork.chain.name}, ${formatEther(registryBalance)} ${NATIVE} on ${sdkRegistry.chain.name}`);
  info(p, `account on Celo: ${celoCode && celoCode !== "0x" ? "set up" : "not set up yet"}; on ${sdkRegistry.chain.name}: ${registryCode && registryCode !== "0x" ? "set up" : "not set up yet"}; ` +
    `keys in the KeyStore: ${keys.length}${keys.length === 0 ? " (this will be a first registration: two writes)" : ""}`);
  if (registryBalance === 0n) check(p, true, `it holds no ${NATIVE} on ${sdkRegistry.chain.name}`);
  else warn(p, `it holds ${formatEther(registryBalance)} ${NATIVE} on ${sdkRegistry.chain.name}; the proof is of a wallet that holds none`);
  if (ctx.role === "usdc") check(p, celoBalance === 0n, "the USDC wallet holds no CELO at all");
  else if (usdcBalance > 0n) info(p, "it also holds USDC; the relay may charge either token");

  try {
    assertCentRecipient(centTo, walletAddresses, ctx.role);
    check(p, true, `the session's one-cent transfer goes to ${centTo}`);
  } catch (err) {
    check(p, false, (err as Error).message);
  }

  const quoted = await quoteFor(ctx, facts, centTo);

  // What a registration will take, from the live fee, gas price and prices. The wallet locks it on Celo.
  const estimate = estimateRegistration({
    registrationFee: facts.registrationFee,
    baseFeePerGas: facts.baseFee,
    priorityFeePerGas: facts.tip,
    firstTime: keys.length === 0,
    native: { decimals: 18, price: facts.prices.native.price },
    token: { decimals: ctx.token.decimals, price },
    marginBps: opts.marginBps,
  });
  // On Celo the grant also pays the relay for the authorization, the funding transaction of each write, and the cache proof.
  const celoFees = quoted.accountFee !== undefined ? quoted.accountFee * BigInt(keys.length === 0 ? 4 : 3) : 0n;
  const total = estimate.lock + celoFees;
  const withRoom = (total * 110n) / 100n;
  info(
    p,
    `estimate for ${keys.length === 0 ? "the first registration (root key and session key)" : "the registration"}: ` +
      `${amountText(estimate.lock, ctx.token)} (${dollars(estimate.usd)}) locked for ${formatEther(estimate.fronted)} ${NATIVE} on ${sdkRegistry.chain.name}` +
      (celoFees > 0n ? `, plus up to ${amountText(celoFees, ctx.token)} of relay fees on Celo` : "") +
      `: ${amountText(total, ctx.token)} (${dollars(usdValue(total, ctx.token.decimals, price))})`,
  );
  if (held >= withRoom) {
    check(p, true, `it holds ${amountText(held, ctx.token)}, more than the estimate plus 10% (${amountText(withRoom, ctx.token)})`);
  } else {
    warn(
      p,
      `it holds ${amountText(held, ctx.token)}, under the estimate plus 10% (${amountText(withRoom, ctx.token)}). ` +
        "A step it cannot pay for is reported as not run; nothing is lost by trying",
    );
  }

  if (!quoted.quote) {
    warn(p, `quoteGrantSession failed: ${quoted.error}`);
  } else {
    for (const line of quoted.quote.lines) {
      info(p, `SDK quote: ${clean(formatQuoteLine(line, networkByChainId(line.chainId) ?? sdkNetwork)).split("\n")[0]}`);
    }
    quotedConversion(ctx, quoted.quote, facts);
    if (!quoted.registryPriced) {
      warn(p, `the relay will not price the registry write for this wallet now${quoted.registryReason ? `: ${quoted.registryReason}` : ""}`);
    } else {
      const short = quoted.quote.balances.filter((b) => b.chainId === CHAIN_ID && !b.sufficient);
      if (short.length > 0) {
        // On a first registration the SDK's quote adds the root key's write to a quote of both keys together, so it reads high.
        warn(p, `the SDK's quote asks for more than the wallet holds: ${short.map((b) => `${formatUnits(b.needed, b.decimals)} ${b.symbol} needed, ${formatUnits(b.balance, b.decimals)} held`).join("; ")}`);
      }
    }
    const cap = quoted.permissions.spend?.[0];
    info(p, `session: one transfer of ${amountText(centTransfer(ctx.role, facts, centTo).amount, ctx.token)}, daily cap ${cap ? amountText(cap.limit, ctx.token) : "?"}, expires 24 hours after the grant`);
  }
  ctx.rec.data.before = { celo: celoBalance, usdc: usdcBalance, registryNative: registryBalance, keyStoreKeys: keys.length };
  ctx.rec.data.estimate = { lock: estimate.lock, fronted: estimate.fronted, usd: estimate.usd, celoFees, total, firstTime: keys.length === 0 };
}

let walletAddresses: Record<Role, Address>;

// ── Testnet funding ─────────────────────────────────────────────────────────

/** Brings a throwaway wallet up to its funding amount from the testnet funder. Never runs on mainnet. */
async function fundTestnetWallet(ctx: Ctx, facts: Facts): Promise<void> {
  if (MAINNET) throw new Error("fundTestnetWallet must never run on mainnet");
  const funderKey = process.env.TEST_FUNDER_KEY as Hex | undefined;
  if (!funderKey) throw new Error("TEST_FUNDER_KEY is not set and no .env.testnet was found beside the repository.");
  const funder = privateKeyToAccount(funderKey);
  const w = createWalletClient({ account: funder, chain: sdkNetwork.chain, transport: http(celoRead.publicRpcUrl) });
  console.log(`\n[funding from the testnet funder ${funder.address}]`);
  if (ctx.role === "celo") {
    const want = parseEther(opts.fundCelo);
    const have = await celoPub.getBalance({ address: ctx.wallet.address });
    if (have >= want) return console.log(`    ${ctx.role}: already holds ${formatEther(have)} CELO`);
    const funderHolds = await celoPub.getBalance({ address: funder.address });
    const spare = funderHolds > parseEther("0.3") ? funderHolds - parseEther("0.3") : 0n;
    const send = want - have > spare ? spare : want - have;
    if (send < want - have) console.log(`    the funder holds ${formatEther(funderHolds)} CELO: sending ${formatEther(send)} instead of ${formatEther(want - have)}`);
    if (send === 0n) return;
    const hash = await w.sendTransaction({ to: ctx.wallet.address, value: send });
    await celoPub.waitForTransactionReceipt({ hash });
    await eventually(async () => (await celoPub.getBalance({ address: ctx.wallet.address })) >= have + send);
    console.log(`    ${ctx.role}: sent ${formatEther(send)} CELO  ${txLink(sdkNetwork, hash)}`);
  } else {
    const want = parseUnits(opts.fundUsdc, facts.usdc.decimals);
    const have = await tokenBalance(facts.usdc, ctx.wallet.address);
    if (have >= want) return console.log(`    ${ctx.role}: already holds ${formatUnits(have, facts.usdc.decimals)} USDC`);
    const funderHolds = await tokenBalance(facts.usdc, funder.address);
    const send = want - have > funderHolds ? funderHolds : want - have;
    if (send < want - have) console.log(`    the funder holds ${formatUnits(funderHolds, facts.usdc.decimals)} USDC: sending that instead of ${formatUnits(want - have, facts.usdc.decimals)}`);
    if (send === 0n) return;
    const hash = await w.writeContract({ address: facts.usdc.address, abi: erc20Abi, functionName: "transfer", args: [ctx.wallet.address, send] });
    await celoPub.waitForTransactionReceipt({ hash });
    await eventually(async () => (await tokenBalance(facts.usdc, ctx.wallet.address)) >= have + send);
    console.log(`    ${ctx.role}: sent ${formatUnits(send, facts.usdc.decimals)} USDC  ${txLink(sdkNetwork, hash)}`);
  }
}

// ── The steps ───────────────────────────────────────────────────────────────

const seconds = (ctx: Ctx) => Number(((Date.now() - ctx.t0) / 1000).toFixed(1));

function row(ctx: Ctx, r: Omit<SummaryRow, "wallet" | "seconds"> & { seconds?: number }): void {
  const full: SummaryRow = { wallet: ctx.role, seconds: seconds(ctx), ...r };
  ctx.rec.rows.push(full);
  console.log(`${ctx.prefix}${full.status.padEnd(4)} ${full.step} [${full.seconds}s] ${full.link}${full.note ? `  ${full.note}` : ""}`);
}

/** The relay's own fee for a transaction, read from its calldata. Undefined when it is not a relay transaction. */
async function intentOf(client: PublicClient, hash: Hex, wallet: Address): Promise<IntentMoney | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const tx = await client.getTransaction({ hash });
      return decodeIntents(tx.input).find((i) => lower(i.eoa) === lower(wallet));
    } catch {
      // A public RPC can take a moment to serve a transaction the relay already saw mined.
      await sleep(2_500);
    }
  }
  return undefined;
}

function sessionOf(ctx: Ctx): Session {
  if (ctx.session) return ctx.session;
  const stored = readSessionFile(ctx.role);
  if (!stored?.session) {
    throw new Error(`No granted session is on file for the ${ctx.role} wallet (${sessionFile(ctx.role)}).`);
  }
  if (lower(stored.wallet) !== lower(ctx.wallet.address)) {
    throw new Error(`The session on file belongs to ${stored.wallet}, not to this wallet ${ctx.wallet.address}.`);
  }
  ctx.session = deserializeSession(stored.session, signerFromPrivateKey(stored.sessionPrivateKey));
  return ctx.session;
}

const idsOf = (session: Session) => ({ keyId: keyIdForSessionOrKey(session), keyHash: keyHashForSessionOrKey(session) });
const expiryText = (session: Session) => new Date(session.expiry * 1000).toISOString().replace(".000Z", "Z");

/** A relay fee as text, in the token it was paid in. */
function feeText(fee: IntentMoney, facts: Facts): string {
  const token = isNative(fee.paymentToken) ? facts.celo : lower(fee.paymentToken) === lower(facts.usdc.address) ? facts.usdc : undefined;
  return token ? amountText(fee.paymentAmount, token) : `${fee.paymentAmount} of ${fee.paymentToken}`;
}

async function stepGrant(ctx: Ctx, facts: Facts, centTo: Address): Promise<void> {
  const client = createClient({ chains: [clientNetwork] });
  // The relay learns the wallet: one signature over its account delegation, no transaction.
  try {
    const created = await client.createWallet({ signer: ctx.admin });
    if (lower(created.address) !== lower(ctx.wallet.address)) {
      throw new Error(`createWallet returned ${created.address}, not the key's address ${ctx.wallet.address}`);
    }
  } catch (err) {
    const code = await celoPub.getCode({ address: ctx.wallet.address });
    if (!code || code === "0x") throw err;
    info(ctx.prefix, `createWallet: ${clean((err as Error).message).split("\n")[0]} (the account already exists on Celo; going on)`);
  }

  const quoted = await quoteFor(ctx, facts, centTo);
  const sessionKey = generatePrivateKey();
  secrets.push(sessionKey);
  const sessionSigner = signerFromPrivateKey(sessionKey);
  // On file before the grant: a session whose key is lost cannot be used or resumed.
  const onFile: SessionFile = {
    network: opts.network,
    role: ctx.role,
    wallet: ctx.wallet.address,
    sessionPrivateKey: sessionKey,
    publicKey: sessionSigner.publicKey,
    createdAt: new Date().toISOString(),
  };
  writeSessionFile(onFile);

  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  ctx.t0 = Date.now();
  ctx.rec.grantStartedAt = new Date(ctx.t0).toISOString();
  ctx.rec.data.celoBlockAtGrant = await celoPub.getBlockNumber();
  ctx.rec.data.balanceAtGrant = await tokenBalance(ctx.token, ctx.wallet.address);
  const events: string[] = [];
  const granted = await client.grantSession({
    wallet: ctx.wallet,
    signer: ctx.admin,
    sessionSigner,
    permissions: quoted.permissions,
    expiry,
    chainId: CHAIN_ID,
    onStatus: (status, detail) => {
      const line = `${seconds(ctx)}s ${status}${detail?.chainId ? ` chain ${detail.chainId}` : ""}${detail?.step ? ` (${detail.step})` : ""}${detail?.reason ? `: ${clean(detail.reason).split("\n")[0]}` : ""}`;
      events.push(line);
      info(ctx.prefix, line);
    },
  });
  ctx.granted = granted;
  ctx.session = granted;
  writeSessionFile({ ...onFile, session: serializeSession(granted) });
  const fee = granted.transactionHash ? await intentOf(celoPub, granted.transactionHash, ctx.wallet.address) : undefined;
  ctx.rec.data.grant = {
    transactionHash: granted.transactionHash,
    status: granted.status,
    keyId: granted.keyId,
    keyHash: granted.keyHash,
    publicKey: granted.publicKey,
    expiry,
    expiresAt: expiryText(granted),
    permissions: serializeSession(granted).permissions,
    legsAtReturn: granted.legs.map(describeLeg).map(clean),
    statusEvents: events,
    ...(fee ? { relayFee: fee.paymentAmount, relayFeeToken: fee.paymentToken } : {}),
  };
  if (!granted.transactionHash) throw new Error("the grant returned no transactionHash");
  if (!(await eventually(() => accountHolds(ctx.wallet.address, granted.keyHash)))) {
    throw new Error("the grant returned, but the account on Celo does not list the key");
  }
  row(ctx, {
    step: "grant",
    chain: sdkNetwork.chain.name,
    link: txLink(sdkNetwork, granted.transactionHash),
    status: "PASS",
    note: `key on the account${fee ? `, fee ${feeText(fee, facts)}` : ""}; session expires ${expiryText(granted)}`,
  });
}

async function stepExecute(ctx: Ctx, facts: Facts, centTo: Address): Promise<void> {
  const client = createClient({ chains: [clientNetwork] });
  const session = sessionOf(ctx);
  const cent = centTransfer(ctx.role, facts, centTo);
  const res = await client.execute({ session, calls: cent.call, chainId: CHAIN_ID });
  const fee = res.transactionHash ? await intentOf(celoPub, res.transactionHash, ctx.wallet.address) : undefined;
  ctx.rec.data.execute = {
    transactionHash: res.transactionHash,
    status: res.status,
    statusCode: res.statusCode,
    feeToken: res.feeToken,
    sent: cent.amount,
    to: centTo,
    ...(fee ? { relayFee: fee.paymentAmount, relayFeeToken: fee.paymentToken } : {}),
  };
  if (res.status !== "CONFIRMED") {
    throw new Error(`the session's transaction did not confirm: status=${res.status}${res.statusCode !== undefined ? ` (relay code ${res.statusCode})` : ""}`);
  }
  if (res.feeToken && lower(res.feeToken) !== lower(ctx.token.address)) {
    throw new Error(`the session's fee was charged in ${res.feeToken}, not in the wallet's ${ctx.token.symbol}`);
  }
  if (ctx.role === "usdc" && (await celoPub.getBalance({ address: ctx.wallet.address })) !== 0n) {
    throw new Error("the USDC wallet holds CELO after its transaction; it must not");
  }
  row(ctx, {
    step: "execute",
    chain: sdkNetwork.chain.name,
    link: txLink(sdkNetwork, res.transactionHash),
    status: "PASS",
    note: `session sent ${amountText(cent.amount, ctx.token)} to ${centTo}${fee ? `, fee ${feeText(fee, facts)}` : ""}`,
  });
}

type WriteOnRecord = { kind: "root" | "session"; transactionHash: Hex };

async function stepRegister(ctx: Ctx): Promise<void> {
  const session = sessionOf(ctx);
  const { keyId } = idsOf(session);
  let leg: SessionLeg | undefined;
  if (ctx.granted) {
    const legs = await ctx.granted.registration;
    leg = legs.find((l) => l.kind === "registry" && l.chainId === sdkRegistry.chainId);
    ctx.rec.data.registration = { legs: legs.map(describeLeg).map(clean), raw: legs };
  } else if (await isValidKey(ctx.wallet.address, keyId)) {
    info(ctx.prefix, "the key is already valid in the KeyStore");
  } else {
    // A resumed run: the grant's own registration is gone with its process, so the key is registered now.
    const client = createClient({ chains: [clientNetwork] });
    const r = await client.registerSessionKey({ wallet: ctx.wallet, signer: ctx.admin, session, chainId: CHAIN_ID });
    if (!r.alreadyRegistered) {
      ctx.rec.data.registration = { resumed: true, registry: r.registry, cache: r.cache, status: r.status };
      if (r.registry) {
        leg = {
          chainId: r.registry.chainId,
          kind: "registry",
          status: r.registry.status,
          ...(r.registry.transactionHash ? { transactionHash: r.registry.transactionHash } : {}),
          ...(r.registry.blockNumber !== undefined ? { blockNumber: r.registry.blockNumber } : {}),
          ...(r.registry.fundedFromChainId !== undefined ? { fundedFromChainId: r.registry.fundedFromChainId } : {}),
          ...(r.registry.sourceTransactionHash ? { sourceTransactionHash: r.registry.sourceTransactionHash } : {}),
          ...(r.registry.reason ? { reason: r.registry.reason } : {}),
        };
      }
    }
  }
  ctx.rec.data.celoBlockAfterRegistration = await celoPub.getBlockNumber();
  const earlier = ((ctx.rec.data.registryWrites ?? []) as WriteOnRecord[]).filter((w) => w.kind === "root");
  const writes: WriteOnRecord[] = [...earlier];
  // The root key's write is a transaction of its own and can have landed even when the session key's did not.
  const root = leg?.rootRegistration;
  if (root?.status === "CONFIRMED" && root.transactionHash && !writes.some((w) => w.transactionHash === root.transactionHash)) {
    writes.push({ kind: "root", transactionHash: root.transactionHash });
    row(ctx, { step: "register (root)", chain: sdkRegistry.chain.name, link: txLink(sdkRegistry, root.transactionHash), status: "PASS", note: "the wallet's root key" });
  }
  ctx.rec.data.registryWrites = writes;
  if (leg && leg.status !== "CONFIRMED") {
    // The SDK's own sentence when it gave one: that is what says why.
    throw new Error(leg.reason ?? `the KeyStore registration is ${leg.status}`);
  }
  if (leg?.transactionHash) writes.push({ kind: "session", transactionHash: leg.transactionHash });
  if (leg?.sourceTransactionHash) ctx.rec.data.sourceTransactionHash = leg.sourceTransactionHash;
  if (!(await eventually(() => isValidKey(ctx.wallet.address, keyId)))) {
    throw new Error(`KeyStore.isValidKey(${ctx.wallet.address}, ${keyId}) is false on ${sdkRegistry.chain.name}`);
  }
  if (leg?.transactionHash) {
    row(ctx, { step: "register (session)", chain: sdkRegistry.chain.name, link: txLink(sdkRegistry, leg.transactionHash), status: "PASS", note: "isValidKey true" });
  } else {
    row(ctx, { step: "register", chain: sdkRegistry.chain.name, link: "", status: "PASS", note: "isValidKey true (registered by an earlier run)" });
  }
}

async function stepMirror(ctx: Ctx): Promise<void> {
  const session = sessionOf(ctx);
  const { keyId } = idsOf(session);
  const cached = async () => {
    const entry = await readCachedKey(celoPub, CACHE, ctx.wallet.address, keyId);
    return lower(entry.publicKey) === lower(session.publicKey) && !entry.revoked;
  };
  let hash: Hex | undefined;
  let l1Block: bigint | undefined;
  if (ctx.granted) {
    info(ctx.prefix, "waiting for Celo to anchor the registration's block; this takes 15 to 30 minutes");
    const legs = await ctx.granted.cacheSync;
    const leg = legs.find((l) => l.kind === "cache" && l.chainId === CHAIN_ID);
    ctx.rec.data.mirror = { legs: legs.map(describeLeg).map(clean), transactionHash: leg?.transactionHash };
    if (!leg || leg.status !== "CONFIRMED") {
      throw new Error(`the proof into the KeyStoreCache is ${leg?.status ?? "missing"}${leg?.reason ? `: ${leg.reason}` : ""}`);
    }
    hash = leg.transactionHash;
    l1Block = leg.l1BlockNumber;
  } else if (await cached()) {
    info(ctx.prefix, "the cache already holds the key");
  } else {
    info(ctx.prefix, "proving the key into the cache; this can take 15 to 30 minutes");
    const client = createClient({ chains: [clientNetwork] });
    const r = await client.syncSessionToCache({ wallet: ctx.wallet, signer: ctx.admin, session, chainId: CHAIN_ID, requireKeyInProof: true });
    ctx.rec.data.mirror = { resumed: true, status: r.status, transactionHash: r.transactionHash, l1BlockNumber: r.l1BlockNumber, attempts: r.attempts };
    if (r.status !== "CONFIRMED") throw new Error(`the proof into the KeyStoreCache did not confirm: status=${r.status}`);
    hash = r.transactionHash;
    l1Block = r.l1BlockNumber;
  }
  if (!(await eventually(cached))) {
    throw new Error(`the KeyStoreCache ${CACHE} does not hold the key after the proof`);
  }
  const entry = await readCachedKey(celoPub, CACHE, ctx.wallet.address, keyId);
  const validNow = await isCachedKeyValid(celoPub, CACHE, ctx.wallet.address, keyId).catch(() => undefined);
  if (entry.expiry !== session.expiry) throw new Error(`the cached expiry ${entry.expiry} is not the session's ${session.expiry}`);
  ctx.rec.data.cacheEntry = { ...entry, isValidKeyNow: validNow };
  row(ctx, {
    step: "mirror",
    chain: sdkNetwork.chain.name,
    link: txLink(sdkNetwork, hash),
    status: "PASS",
    note: `cached, not revoked, proven at ${sdkRegistry.chain.name} block ${entry.sourceBlockNumber}${l1Block !== undefined && l1Block !== entry.sourceBlockNumber ? ` (proof built at ${l1Block})` : ""}`,
  });
}

/** Every escrow the wallet opened on Celo between two blocks, read from the escrow contract. */
async function escrowsOf(wallet: Address, escrow: Address, from: bigint, to: bigint) {
  const found: { id: Hex; transactionHash: Hex; blockNumber: bigint; token: Address; amount: bigint; status: string }[] = [];
  for (let start = from; start <= to; start += 4_000n) {
    const end = start + 3_999n > to ? to : start + 3_999n;
    const logs = await celoPub.getLogs({ address: escrow, event: ESCROW_ABI[0], fromBlock: start, toBlock: end });
    for (const log of logs) {
      const id = log.args.escrowId;
      if (!id) continue;
      const [e, status] = await Promise.all([
        celoPub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "escrows", args: [id] }),
        celoPub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "statuses", args: [id] }),
      ]);
      if (lower(e[1]) !== lower(wallet)) continue;
      found.push({ id, transactionHash: log.transactionHash, blockNumber: log.blockNumber, token: e[3], amount: e[4], status: ESCROW_STATUS[status] ?? String(status) });
    }
  }
  return found;
}

/**
 * What the grant cost the wallet, leg by leg, in its own token, read from the
 * chains: the relay's fee in each of the wallet's transactions on Celo, and
 * what it locked in escrow for the writes on the registry chain.
 */
async function stepCharge(ctx: Ctx, facts: Facts, final = true): Promise<void> {
  const p = ctx.prefix;
  const grant = ctx.rec.data.grant as { transactionHash?: Hex } | undefined;
  if (!grant?.transactionHash) {
    if (final) row(ctx, { step: "charge", chain: "", link: "", status: "INFO", note: "no grant on record; nothing was charged" });
    return;
  }
  const writes = (ctx.rec.data.registryWrites ?? []) as WriteOnRecord[];
  const from = BigInt(String(ctx.rec.data.celoBlockAtGrant ?? 0));
  const to = BigInt(String(ctx.rec.data.celoBlockAfterRegistration ?? (await celoPub.getBlockNumber())));
  const escrows = from > 0n ? await escrowsOf(ctx.wallet.address, facts.escrow, from, to) : [];
  const foreign = escrows.find((e) => lower(e.token) !== lower(ctx.token.address));
  if (foreign) throw new Error(`an escrow was locked in ${foreign.token}, not in the wallet's ${ctx.token.symbol}`);

  // The prices of the time: the feeds as they stood when the grant's first payment was made.
  const grantReceipt = await celoPub.getTransactionReceipt({ hash: grant.transactionHash });
  const lockBlock = escrows[0]?.blockNumber ?? grantReceipt.blockNumber;
  const lockTime = (await celoPub.getBlock({ blockNumber: lockBlock })).timestamp;
  const [nativeRead, tokenRead] = await Promise.all([
    readFeed(nativeFeed!, lockTime),
    ctx.role === "celo" ? readFeed(celoFeed!, lockTime) : usdcFeed ? readFeed(usdcFeed, lockTime) : Promise.resolve(facts.prices.usdc),
  ]);

  // The registry writes, as their own transactions state them.
  const registryWrites: RegistryWrite[] = [];
  for (const w of writes) {
    const [receipt, intent] = await Promise.all([
      regPub.getTransactionReceipt({ hash: w.transactionHash }),
      intentOf(regPub, w.transactionHash, ctx.wallet.address),
    ]);
    if (!intent) throw new Error(`the ${w.kind} write ${w.transactionHash} is not a relay intent of this wallet; its funding cannot be read`);
    const fronted = intent.funded.filter((f) => isNative(f.token)).reduce((s, f) => s + f.amount, 0n);
    if (fronted === 0n) throw new Error(`the ${w.kind} write ${w.transactionHash} carries no fronted ${NATIVE}`);
    if (!isNative(intent.paymentToken)) throw new Error(`the ${w.kind} write paid its fee in ${intent.paymentToken}, not ${NATIVE}`);
    // The fee the KeyStore took is the one in force at the write's block; an RPC without that state answers with today's.
    const registrationFee = await regPub
      .readContract({ address: sdkRegistry.keyStoreController, abi: CONTROLLER_ABI, functionName: "getRegistrationFeeInWei", blockNumber: receipt.blockNumber })
      .catch(() => facts.registrationFee);
    registryWrites.push({ kind: w.kind, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, registrationFee, fronted, relayFee: intent.paymentAmount });
  }

  // The conversion: what was locked against what was fronted, at the feeds. Judged only when each write has its escrow.
  let tokenAt: { price: UsdPrice; updatedAt: bigint } = { price: tokenRead.price, updatedAt: tokenRead.updatedAt };
  let nativeAt: { price: UsdPrice; updatedAt: bigint } = { price: nativeRead.price, updatedAt: nativeRead.updatedAt };
  const locked = escrows.reduce((s, e) => s + e.amount, 0n);
  let report: ReturnType<typeof chargeReport> | undefined;
  if (registryWrites.length > 0 && escrows.length === registryWrites.length) {
    // The relay keeps a price for a few minutes and a quote lives a little longer, so the price it
    // charged at is the feed's answer at the lock or, when that answer was only just written, the
    // one before it. No older answer is considered.
    const candidates = (r: FeedReading) => [
      { price: r.price, updatedAt: r.updatedAt },
      ...(r.previous && r.updatedAt > lockTime - BigInt(facts.priceWindowSecs) ? [r.previous] : []),
    ];
    const reportAt = (native: { price: UsdPrice }, token: { price: UsdPrice }) =>
      chargeReport({
        token: { symbol: ctx.token.symbol, decimals: ctx.token.decimals, price: token.price },
        native: { symbol: NATIVE, decimals: 18, price: native.price },
        writes: registryWrites,
        locked,
        marginBps: opts.marginBps,
        toleranceBps: opts.marginToleranceBps,
      });
    report = reportAt(nativeAt, tokenAt);
    for (const n of candidates(nativeRead)) {
      for (const t of candidates(tokenRead)) {
        const r = reportAt(n, t);
        if (Math.abs(r.conversionMarginBps - opts.marginBps) < Math.abs(report.conversionMarginBps - opts.marginBps)) {
          [nativeAt, tokenAt, report] = [n, t, r];
        }
      }
    }
  }

  // The charge, leg by leg, in the wallet's own token.
  const usd = (v: bigint) => dollars(usdValue(v, ctx.token.decimals, tokenAt.price));
  const inToken = (fee: IntentMoney | undefined) => (fee && lower(fee.paymentToken) === lower(ctx.token.address) ? fee.paymentAmount : undefined);
  const legs: { leg: string; amount: bigint; link: string }[] = [];
  const authorization = inToken(await intentOf(celoPub, grant.transactionHash, ctx.wallet.address));
  if (authorization !== undefined) legs.push({ leg: "account authorization on Celo (relay fee)", amount: authorization, link: txLink(sdkNetwork, grant.transactionHash) });
  for (const [i, e] of escrows.entries()) {
    const kind = writes[i]?.kind ?? (i === 0 && escrows.length > 1 ? "root" : "session");
    const fee = inToken(await intentOf(celoPub, e.transactionHash, ctx.wallet.address)) ?? 0n;
    legs.push({ leg: `registry write, ${kind} key: locked for ${sdkRegistry.chain.name}`, amount: e.amount, link: txLink(sdkNetwork, e.transactionHash) });
    legs.push({ leg: `registry write, ${kind} key: relay fee on Celo`, amount: fee, link: "" });
  }
  const mirror = ctx.rec.data.mirror as { transactionHash?: Hex } | undefined;
  if (mirror?.transactionHash) {
    const proof = inToken(await intentOf(celoPub, mirror.transactionHash, ctx.wallet.address));
    if (proof !== undefined) legs.push({ leg: "cache proof on Celo (relay fee)", amount: proof, link: txLink(sdkNetwork, mirror.transactionHash) });
  }
  const total = legs.reduce((s, l) => s + l.amount, 0n);
  const width = Math.max(...legs.map((l) => l.leg.length), 5);
  console.log(`${p}     CHARGED FOR THE GRANT${final ? "" : " SO FAR"}, in ${ctx.token.symbol} (${ctx.token.symbol} at ${priceText(tokenAt.price)}, the Chainlink answer at the time)`);
  for (const l of legs) console.log(`${p}       ${l.leg.padEnd(width)}  ${amountText(l.amount, ctx.token).padStart(28)}  ${usd(l.amount).padStart(9)}  ${l.link}`);
  console.log(`${p}       ${"TOTAL".padEnd(width)}  ${amountText(total, ctx.token).padStart(28)}  ${usd(total).padStart(9)}`);
  const registryLeft = await regPub.getBalance({ address: ctx.wallet.address });
  if (registryLeft > 0n) {
    info(p, `of what was locked, ${formatEther(registryLeft)} ${NATIVE} (${dollars(usdValue(registryLeft, 18, nativeAt.price))}) is in the wallet on ${sdkRegistry.chain.name}: the unused part of the gas budget, and it is the wallet's`);
  }
  if (!mirror?.transactionHash) info(p, final ? "the cache proof is not in this total: it was not sent" : "the cache proof is still to come and is not in this total; the final figure follows the mirror step");
  if (ctx.role === "usdc" && !usdcFeed) info(p, "USDC is taken as $1 here");

  for (const e of escrows) info(p, `escrow ${e.status}: ${amountText(e.amount, ctx.token)}  ${txLink(sdkNetwork, e.transactionHash)}`);
  for (const [i, w] of registryWrites.entries()) {
    info(p, `${w.kind} write on ${sdkRegistry.chain.name}: fronted ${formatEther(w.fronted)} ${NATIVE}, relay fee ${formatEther(w.relayFee)}, gas ${w.gasUsed} at ${formatGwei(w.effectiveGasPrice)} gwei, KeyStore fee ${formatEther(w.registrationFee)}  ${txLink(sdkRegistry, writes[i]!.transactionHash)}`);
  }
  if (report) {
    for (const line of report.lines) info(p, line);
    info(p, `prices are the feeds' answers written ${lockTime - nativeAt.updatedAt}s (${NATIVE}) and ${tokenAt.updatedAt === 0n ? "n/a" : `${lockTime - tokenAt.updatedAt}s`} (${ctx.token.symbol}) before the lock`);
  } else if (registryWrites.length > 0) {
    info(p, `${escrows.length} escrow(s) for ${registryWrites.length} registry write(s): they cannot be paired, so the conversion margin is not judged`);
  }

  ctx.rec.data.charge = {
    token: ctx.token.symbol,
    legs,
    total,
    totalUsd: usdValue(total, ctx.token.decimals, tokenAt.price),
    tokenPrice: priceText(tokenAt.price),
    nativePrice: priceText(nativeAt.price),
    lockTime,
    locked,
    escrows,
    writes: registryWrites,
    registryNativeLeft: registryLeft,
    ...(report
      ? {
          fronted: report.fronted,
          frontedInToken: report.frontedInToken,
          actualCost: report.actualCost,
          actualCostInToken: report.actualCostInToken,
          conversionMarginBps: report.conversionMarginBps,
          overActualCostBps: report.overActualCostBps,
          verdict: report.verdict,
          lines: report.lines,
        }
      : {}),
  };
  if (!final) return;
  row(ctx, {
    step: "charge",
    chain: "",
    link: "",
    status: report ? report.verdict : "INFO",
    note:
      `the grant cost ${amountText(total, ctx.token)} (${usd(total)})` +
      (report ? `; locked ${(report.conversionMarginBps / 100).toFixed(2)}% above the feeds for what was fronted (margin ${(opts.marginBps / 100).toFixed(2)}%)` : ""),
  });
  if (report?.verdict === "FAIL") failed++;
}

async function stepRevoke(ctx: Ctx): Promise<void> {
  const session = sessionOf(ctx);
  const { keyId, keyHash } = idsOf(session);
  const held = await accountHolds(ctx.wallet.address, keyHash);
  const valid = await isValidKey(ctx.wallet.address, keyId);
  if (!held && !valid) {
    row(ctx, { step: "revoke", chain: sdkNetwork.chain.name, link: "", status: "PASS", note: "already revoked: not on the account, not valid in the KeyStore" });
    return;
  }
  const client = createClient({ chains: [clientNetwork] });
  let legs: SessionLeg[];
  let hash: Hex | undefined;
  let registryRefused: string | undefined;
  try {
    const result = await client.revokeSession({ wallet: ctx.wallet, signer: ctx.admin, session, chainId: CHAIN_ID });
    ctx.revokeCacheSync = result.cacheSync;
    legs = result.legs;
    hash = result.transactionHash;
  } catch (err) {
    if (!(err instanceof SessionRevokeError)) throw err;
    legs = err.result.legs;
    ctx.rec.data.revoke = { legs: legs.map(describeLeg).map(clean) };
    const account = legs.find((l) => l.kind === "account" && l.chainId === CHAIN_ID);
    // The account's own revoke is what stops the key. When it went through and only the KeyStore's
    // could not be paid for, the key is dead and the registry entry simply lapses at the expiry.
    if (account?.status !== "CONFIRMED" || !isInsufficientFunds(err)) throw err;
    hash = account.transactionHash;
    registryRefused = legs.find((l) => l.kind === "registry" && l.status === "FAILED")?.reason ?? err.message;
  }
  const registry = legs.find((l) => l.kind === "registry" && l.chainId === sdkRegistry.chainId);
  ctx.rec.data.revoke = { transactionHash: hash, legs: legs.map(describeLeg).map(clean), registryTransactionHash: registry?.transactionHash, registryRefused };
  if (!(await eventually(async () => !(await accountHolds(ctx.wallet.address, keyHash))))) {
    throw new Error("the account on Celo still lists the key after the revoke");
  }
  row(ctx, { step: "revoke", chain: sdkNetwork.chain.name, link: txLink(sdkNetwork, hash), status: "PASS", note: "key gone from the account" });
  if (registryRefused) {
    info(ctx.prefix, `SDK: ${clean(registryRefused).split("\n")[0]} (code insufficient_funds)`);
    row(ctx, {
      step: "revoke (registry)",
      chain: sdkRegistry.chain.name,
      link: "",
      status: "NOT RUN",
      note: `not run: insufficient funds. The account refuses the key already; the KeyStore lists it until it expires ${expiryText(session)}`,
    });
    ctx.blocked.set("revoke-mirror", "the KeyStore revoke was not paid for, so there is no revocation to mirror");
    return;
  }
  if (!(await eventually(async () => !(await isValidKey(ctx.wallet.address, keyId))))) {
    throw new Error(`the KeyStore on ${sdkRegistry.chain.name} still lists the key as valid after the revoke`);
  }
  if (registry?.transactionHash) {
    row(ctx, { step: "revoke (registry)", chain: sdkRegistry.chain.name, link: txLink(sdkRegistry, registry.transactionHash), status: "PASS", note: "isValidKey false" });
  }
}

async function stepRevokeMirror(ctx: Ctx): Promise<void> {
  const session = sessionOf(ctx);
  const { keyId } = idsOf(session);
  const entryNow = await readCachedKey(celoPub, CACHE, ctx.wallet.address, keyId);
  let hash: Hex | undefined;
  if (entryNow.publicKey === "0x") {
    row(ctx, { step: "revoke-mirror", chain: sdkNetwork.chain.name, link: "", status: "PASS", note: "the cache never held the key; nothing to prove" });
    return;
  }
  if (entryNow.revoked) {
    row(ctx, { step: "revoke-mirror", chain: sdkNetwork.chain.name, link: "", status: "PASS", note: "the cache already shows the key revoked" });
    return;
  }
  if (await isValidKey(ctx.wallet.address, keyId)) {
    throw new Error(`the KeyStore still lists the key as valid, so there is no revocation to prove into the cache`);
  }
  if (ctx.revokeCacheSync) {
    info(ctx.prefix, "waiting for Celo to anchor the revocation's block; this takes 15 to 30 minutes");
    const legs = await ctx.revokeCacheSync;
    const leg = legs.find((l) => l.kind === "cache" && l.chainId === CHAIN_ID);
    ctx.rec.data.revokeMirror = { legs: legs.map(describeLeg).map(clean) };
    if (!leg || leg.status !== "CONFIRMED") {
      throw new Error(`the post-revocation proof is ${leg?.status ?? "missing"}${leg?.reason ? `: ${leg.reason}` : ""}`);
    }
    hash = leg.transactionHash;
  } else {
    info(ctx.prefix, "proving the revocation into the cache; this can take 15 to 30 minutes");
    const client = createClient({ chains: [clientNetwork] });
    const r = await client.syncSessionToCache({ wallet: ctx.wallet, signer: ctx.admin, session, chainId: CHAIN_ID, requireKeyInProof: true });
    ctx.rec.data.revokeMirror = { resumed: true, status: r.status, transactionHash: r.transactionHash, l1BlockNumber: r.l1BlockNumber };
    if (r.status !== "CONFIRMED") throw new Error(`the post-revocation proof did not confirm: status=${r.status}`);
    hash = r.transactionHash;
  }
  if (!(await eventually(async () => (await readCachedKey(celoPub, CACHE, ctx.wallet.address, keyId)).revoked))) {
    throw new Error(`the KeyStoreCache ${CACHE} still shows the key live after the post-revocation proof`);
  }
  row(ctx, { step: "revoke-mirror", chain: sdkNetwork.chain.name, link: txLink(sdkNetwork, hash), status: "PASS", note: "the cache shows the key revoked" });
}

/** Only with `--sweep-to`: returns the wallet's token on Celo through the relay, and any native token left on the registry chain. */
async function stepSweep(ctx: Ctx, to: Address): Promise<void> {
  const client = createClient({ chains: [clientNetwork] });
  const balance = await tokenBalance(ctx.token, ctx.wallet.address);
  const callFor = (amount: bigint) =>
    ctx.role === "celo"
      ? { to, value: amount, data: "0x" as Hex }
      : { to: ctx.token.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
  const swept: Record<string, unknown> = {};
  if (balance > 0n) {
    // The relay's own quote for this transfer is what has to stay behind to pay for it.
    const quote = await client.quoteExecute({ wallet: ctx.wallet, signer: ctx.admin, calls: callFor(1n), chainId: CHAIN_ID });
    if (lower(quote.feeToken) !== lower(ctx.token.address)) {
      throw new Error(`the relay would charge the sweep in ${quote.feeToken}, not in the wallet's ${ctx.token.symbol}`);
    }
    const amount = sweepAmount(balance, quote.fee);
    if (amount === 0n) {
      row(ctx, { step: "sweep", chain: sdkNetwork.chain.name, link: "", status: "SKIP", note: `${amountText(balance, ctx.token)} left, not more than the fee of sending it` });
    } else {
      const res = await client.execute({ wallet: ctx.wallet, signer: ctx.admin, calls: callFor(amount), chainId: CHAIN_ID });
      swept.celo = { amount, transactionHash: res.transactionHash, status: res.status };
      if (res.status !== "CONFIRMED") throw new Error(`the sweep did not confirm: status=${res.status}`);
      row(ctx, { step: "sweep", chain: sdkNetwork.chain.name, link: txLink(sdkNetwork, res.transactionHash), status: "PASS", note: `returned ${amountText(amount, ctx.token)} to ${to}` });
    }
  } else {
    row(ctx, { step: "sweep", chain: sdkNetwork.chain.name, link: "", status: "SKIP", note: `no ${ctx.token.symbol} left` });
  }

  // What the registry writes left on the registry chain is the wallet's own: a plain transfer from its key.
  const account = privateKeyToAccount(ctx.adminKey);
  const w = createWalletClient({ account, chain: sdkRegistry.chain, transport: http(registryRead.publicRpcUrl) });
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const held = await regPub.getBalance({ address: account.address });
      if (held === 0n) break;
      const fees = await regPub.estimateFeesPerGas();
      const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? (await regPub.getGasPrice());
      const gas = ((await regPub.estimateGas({ account: account.address, to, value: 1n }).catch(() => 21_000n)) * 12n) / 10n;
      const value = held - gas * perGas;
      if (value <= 0n) {
        row(ctx, { step: "sweep (registry chain)", chain: sdkRegistry.chain.name, link: "", status: "SKIP", note: `${formatEther(held)} ${NATIVE} left, not more than the gas to send it` });
        break;
      }
      const hash = await w.sendTransaction({
        to,
        value,
        gas,
        ...(fees.maxFeePerGas !== undefined ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : { gasPrice: perGas }),
      });
      const receipt = await regPub.waitForTransactionReceipt({ hash });
      swept.registry = { amount: value, transactionHash: hash, status: receipt.status };
      if (receipt.status !== "success") throw new Error(`the transfer on ${sdkRegistry.chain.name} reverted`);
      row(ctx, { step: "sweep (registry chain)", chain: sdkRegistry.chain.name, link: txLink(sdkRegistry, hash), status: "PASS", note: `returned ${formatEther(value)} ${NATIVE}` });
      break;
    } catch (err) {
      // A balance read just after the last write can be a block stale, which sizes the transfer too high.
      if (attempt === 5) throw err;
      await sleep(6_000);
    }
  }
  ctx.rec.data.sweep = swept;
}

/** What the wallet holds now, printed and recorded. */
async function finalBalances(ctx: Ctx, facts: Facts): Promise<void> {
  await sleep(4_000);
  const [celoLeft, usdcLeft, registryLeft] = await Promise.all([
    celoPub.getBalance({ address: ctx.wallet.address }),
    tokenBalance(facts.usdc, ctx.wallet.address),
    regPub.getBalance({ address: ctx.wallet.address }),
  ]);
  ctx.rec.data.after = { celo: celoLeft, usdc: usdcLeft, registryNative: registryLeft };
  const before = ctx.rec.data.before as { celo?: unknown; usdc?: unknown } | undefined;
  const was = before ? BigInt(String(ctx.role === "celo" ? before.celo : before.usdc)) : undefined;
  const now = ctx.role === "celo" ? celoLeft : usdcLeft;
  console.log(
    `\n${ctx.prefix}the wallet now holds ${formatEther(celoLeft)} CELO, ${formatUnits(usdcLeft, facts.usdc.decimals)} USDC, ${formatEther(registryLeft)} ${NATIVE} on ${sdkRegistry.chain.name}` +
      (was !== undefined && was >= now ? `; this run took ${amountText(was - now, ctx.token)} in all` : ""),
  );
}

/**
 * Runs the wallet's steps in order from `start`.
 *
 * A step the wallet cannot pay for is reported as not run and the run goes on
 * with what does not depend on it. Any other failure stops the wallet.
 */
async function runWallet(ctx: Ctx, facts: Facts, centTo: Address, steps: readonly Step[]): Promise<void> {
  const run: Record<Step, () => Promise<void>> = {
    grant: () => stepGrant(ctx, facts, centTo),
    execute: () => stepExecute(ctx, facts, centTo),
    register: () => stepRegister(ctx),
    mirror: () => stepMirror(ctx),
    charge: () => stepCharge(ctx, facts),
    revoke: () => stepRevoke(ctx),
    "revoke-mirror": () => stepRevokeMirror(ctx),
    sweep: () => stepSweep(ctx, opts.sweepTo!),
  };
  const blocked = ctx.blocked;
  for (const step of steps) {
    console.log(`${ctx.prefix}---- ${step}`);
    const why = blocked.get(step);
    if (why) {
      ctx.rec.steps[step] = "NOT RUN";
      row(ctx, { step, chain: "", link: "", status: "NOT RUN", note: `not run: ${why}` });
      saveRecord();
      continue;
    }
    try {
      await run[step]();
      ctx.rec.steps[step] = "PASS";
      delete ctx.rec.error;
      // The number that matters most, as soon as it exists: the mirror step that follows takes 15 to 30 minutes.
      if (step === "register" && steps.includes("mirror")) {
        await stepCharge(ctx, facts, false).catch((err) => info(ctx.prefix, `the charge so far could not be read yet: ${clean((err as Error).message).split("\n")[0]}`));
      }
    } catch (err) {
      const described = describeError(err, secrets);
      const code = altanaErrorOf(err)?.code ?? described.code;
      if (isInsufficientFunds(err)) {
        // Expected on a wallet funded to the cent: said in the SDK's own words, and the run goes on.
        ctx.rec.steps[step] = "NOT RUN";
        ctx.rec.data[`${step}NotRun`] = { reason: "insufficient funds", ...described, code: code ?? "insufficient_funds" };
        info(ctx.prefix, `SDK: ${described.message.split("\n")[0]} (code ${code ?? "insufficient_funds"})`);
        row(ctx, { step, chain: "", link: "", status: "NOT RUN", note: "not run: insufficient funds" });
        if (step === "grant") for (const s of steps) blocked.set(s, "the session was not granted");
        if (step === "register") blocked.set("mirror", "the key is not registered, so there is nothing to mirror");
        if (step === "revoke") {
          blocked.set("revoke-mirror", "the key was not revoked");
          const session = ctx.session ?? (readSessionFile(ctx.role)?.session ? sessionOf(ctx) : undefined);
          if (session) info(ctx.prefix, `the session was not revoked. It expires ${expiryText(session)} and may only make its one-cent transfer until then`);
        }
        saveRecord();
        continue;
      }
      ctx.rec.steps[step] = "FAIL";
      failed++;
      ctx.rec.error = { step, ...described };
      row(ctx, { step, chain: "", link: "", status: "FAIL", note: described.message.split("\n")[0]! });
      console.log(`${ctx.prefix}     ${described.name}${code ? ` (code ${code})` : ""}:`);
      for (const line of described.message.split("\n")) console.log(`${ctx.prefix}       | ${line}`);
      for (const cause of described.causes) console.log(`${ctx.prefix}       <- ${cause}`);
      if (described.detail) console.log(`${ctx.prefix}       detail: ${described.detail.split("\n")[0]}`);
      console.log(`${ctx.prefix}     stopped here. Run the same command with --resume to continue from "${step}"; the session key is on file.`);
      saveRecord();
      return;
    }
    saveRecord();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

/** A mainnet send is typed in by a person at a terminal, and by nobody else. */
async function confirmMainnet(ctx: Ctx): Promise<void> {
  assertCanConfirm(opts, process.stdin.isTTY === true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nThis will SIGN AND SEND on Celo mainnet from the ${ctx.role} wallet ${ctx.wallet.address}, with real funds.\nType "${MAINNET_PHRASE}" to continue: `,
  );
  rl.close();
  if (!isConfirmed(answer)) throw new Error("Not confirmed. Nothing was sent.");
}

async function main(): Promise<void> {
  const bar = "=".repeat(92);
  console.log(bar);
  console.log(`Altana SDK live proof on ${sdkNetwork.chain.name} (chain ${CHAIN_ID}); KeyStore on ${sdkRegistry.chain.name} (chain ${sdkRegistry.chainId})`);
  console.log(`relay ${RELAY_URL}; SDK ${sdkBuild.describe}`);
  console.log(
    opts.send
      ? `MODE: SEND, ${opts.wallet} wallet. This run signs and sends transactions${MAINNET ? " WITH REAL FUNDS ON MAINNET" : " on the testnet"}.`
      : "MODE: DRY RUN. Nothing is signed and nothing is sent.",
  );
  console.log(
    `SDK client RPCs: ${opts.clientRpc === "env" ? "from the environment" : "the SDK's own defaults"}; this script's reads: ${envCeloRpc ? ENV.celoRpc : "SDK default"} / ${envRegistryRpc ? ENV.registryRpc : "SDK default"}` +
      (ENV_FILE ? `; env file loaded: ${ENV_FILE}` : ""),
  );
  console.log(bar);

  const facts = await relayAndChainChecks();
  const { keys, note } = adminKeys();
  walletAddresses = { celo: privateKeyToAccount(keys.celo).address, usdc: privateKeyToAccount(keys.usdc).address };
  const centTo: Address | undefined = opts.sendCentTo ?? (MAINNET ? MAINNET_CENT_RECIPIENT : (process.env.TEST_FUNDER_ADDRESS as Address | undefined));
  if (!centTo) throw new Error("Nowhere to send the session's one cent: pass --send-cent-to <address> (TEST_FUNDER_ADDRESS is not set).");

  const roles = (["celo", "usdc"] as const).filter((r) => !opts.wallet || opts.wallet === r);
  const previous = opts.resume ? loadPreviousRecord() : undefined;
  if (previous?.wallets) record.wallets = { ...previous.wallets };
  const ctxs: Ctx[] = roles.map((role) => {
    const token = role === "celo" ? facts.celo : facts.usdc;
    const earlier = previous?.wallets?.[role];
    const rec: WalletRecord =
      earlier && lower(earlier.address) === lower(walletAddresses[role])
        ? { ...earlier, rows: earlier.rows.filter((r) => r.status === "PASS" || r.status === "INFO") }
        : { role, address: walletAddresses[role], token: token.symbol, steps: {}, rows: [], data: {} };
    record.wallets[role] = rec;
    return {
      role,
      prefix: `  [${role}] `,
      admin: signerFromPrivateKey(keys[role]),
      adminKey: keys[role],
      wallet: { address: walletAddresses[role] },
      token,
      rec,
      t0: rec.grantStartedAt ? Date.parse(rec.grantStartedAt) : Date.now(),
      blocked: new Map(),
    };
  });

  if (opts.send && !MAINNET && !opts.resume) await fundTestnetWallet(ctxs[0]!, facts);
  for (const ctx of ctxs) await walletChecks(ctx, facts, note[ctx.role], centTo);
  record.preconditions.failed = failed;
  record.preconditions.warnings = warnings;
  saveRecord();

  if (!opts.send) {
    console.log(`\n${bar}`);
    console.log(
      (failed === 0 ? "DRY RUN: nothing stands in the way of a send." : `DRY RUN: ${failed} check(s) marked FAIL would stop a send.`) +
        (warnings > 0 ? ` ${warnings} warning(s) above would not.` : "") +
        " Nothing was signed or sent.",
    );
    console.log(`record: ${RECORD_FILE}`);
    process.exit(failed === 0 ? 0 : 1);
  }

  // From here on the run signs. The checks marked FAIL decide whether it may.
  const ctx = ctxs[0]!;
  const steps = stepsFor(opts);
  let start: Step | undefined = "grant";
  const onFile = readSessionFile(ctx.role);
  if (opts.resume) {
    start = opts.from ?? firstStepNotDone(ctx.rec.steps, steps);
    if (start && start !== "grant" && !onFile?.session) {
      throw new Error(`The ${ctx.role} wallet cannot be resumed: no granted session is on file at ${sessionFile(ctx.role)}.`);
    }
  } else if (onFile && !opts.discardSession && lower(onFile.wallet) === lower(ctx.wallet.address)) {
    throw new Error(
      `An earlier run left a session for the ${ctx.role} wallet (${sessionFile(ctx.role)}). ` +
        "Pass --resume to continue it, or --discard-session to start over; the old key then stays authorized on the account until it expires.",
    );
  }
  if (failed > 0) throw new Error(`${failed} check(s) marked FAIL above stand in the way. Nothing was signed or sent.`);
  if (!start) {
    console.log(`\n${ctx.prefix}every step of the earlier run is done; nothing to resume`);
  } else {
    if (MAINNET) await confirmMainnet(ctx);
    console.log(`\n${bar}\nRunning the ${ctx.role} wallet from "${start}"${opts.sweepTo ? `; leftovers go to ${opts.sweepTo}` : "; nothing is swept, leftovers stay in the wallet"}\n${bar}`);
    await runWallet(ctx, facts, centTo, steps.slice(steps.indexOf(start)));
    await finalBalances(ctx, facts);
  }

  record.finishedAt = new Date().toISOString();
  saveRecord();
  // A copy that the next run does not overwrite.
  const kept = RECORD_FILE.replace(/\.json$/, `-${record.startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(kept, readFileSync(RECORD_FILE));
  console.log(`\n${bar}\nSummary (t is seconds since the grant started)\n`);
  for (const line of summaryTable(ctx.rec.rows)) console.log(line);
  const session = ctx.session ?? (onFile?.session ? sessionOf(ctx) : undefined);
  if (session && ctx.rec.steps.revoke !== "PASS") console.log(`\nThe session was not revoked: it expires ${expiryText(session)}.`);
  console.log(`\nrecord: ${RECORD_FILE}\n  kept as ${kept}`);
  const notRun = ctx.rec.rows.some((r) => r.status === "NOT RUN");
  console.log(failed === 0 ? `Result: PASS${notRun ? " (the steps marked NOT RUN were not paid for and did not run)" : ""}` : `Result: FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  const d = describeError(err, secrets);
  console.error(`\n${d.name}: ${d.message}`);
  for (const cause of d.causes) console.error(`  <- ${cause}`);
  try {
    saveRecord();
  } catch {
    // The record is best effort when the run could not even start.
  }
  process.exit(1);
});
