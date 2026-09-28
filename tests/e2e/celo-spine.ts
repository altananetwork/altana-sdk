/**
 * THE SPINE: the one flow Celo milestones 1 and 2 stand on, run end to end on
 * Celo Sepolia (11142220) through public SDK calls, with the KeyStore on
 * Ethereum Sepolia (11155111).
 *
 *   S1  A fresh wallet funded with CELO only. Sepolia ETH asserted 0.
 *   S2a Execute on Celo paying CELO.
 *   S2b Execute paying each stablecoin, from a wallet holding only that token.
 *   S3  Register a session key in the Sepolia KeyStore paid from the Celo
 *       balance. `isValidKey` true on Sepolia, and the write reports
 *       `fundedFromChainId` = Celo Sepolia.
 *   S4  The cache proof: the key is valid in the Celo mirror, with the
 *       anchored L1 block printed.
 *   S5a Use the session key.
 *   S5b A second key with a short expiry, then rejection after it expires.
 *   S5c Revoke the first key: rejection, and the mirror shows it revoked.
 *   S6  Refund the funder.
 *
 * Every step is independent where it can be: a step that cannot run because
 * an earlier one failed is reported SKIPPED with the reason, so one failure
 * never hides the rest. The run always reaches S6 and always refunds.
 *
 * The script prints a step table and writes the same table, with explorer
 * links, to `celo-harness/evidence/` (override with SPINE_EVIDENCE_DIR).
 *
 * Which relay:
 *   --relay <url>     the relay for both chains (default: the SDK's testnet
 *                     relay, i.e. Railway). Use infra's local relay-staging
 *                     instance to exercise PR #25 and #26.
 *   --fork            fork mode: point both chains at anvil forks (see
 *                     SPINE_FORK_CELO_RPC / SPINE_FORK_SEPOLIA_RPC) and set
 *                     stablecoin balances with anvil_setStorageAt rather than
 *                     transferring them. Use when a token cannot be funded
 *                     live; the result is marked "Proven (fork)".
 *
 * Other flags:
 *   --steps s1,s2a    run only these steps (S6 always runs)
 *   --tokens usdc,..  which stablecoins S2b should try (default: every one
 *                     the relay accepts AND the funder can pay for)
 *   --keep            skip S6, leaving the wallets funded for inspection
 *
 * Needs:
 *   TEST_FUNDER_KEY       CELO on Celo Sepolia; no Sepolia ETH is spent
 *   CELO_SEPOLIA_RPC_URL  optional read-RPC override
 *   SEPOLIA_RPC_URL       optional; must serve eth_getProof at the block Celo
 *                         Sepolia anchors (about 100 behind head)
 *
 * Run: bun run spine                    (from tests/e2e)
 *      bun run spine -- --relay http://127.0.0.1:19129
 */

import {
  createClient,
  createPrivateKeySigner,
  isCachedKeyValid,
  readCachedKey,
  keyStoreCacheOf,
  CELO_SEPOLIA,
  SEPOLIA,
  NATIVE_TOKEN,
  type FeeCurrency,
  type NetworkConfig,
  type Session,
  type SessionLeg,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  pad,
  parseEther,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describeLeg, legOf } from "./session-legs.js";

// ---------------------------------------------------------------------------
// Arguments and configuration
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}
const has = (name: string) => argv.includes(`--${name}`);

const FORK = has("fork");
const KEEP = has("keep");
const RELAY_URL = flag("relay") ?? process.env.RELAY_URL;
const ONLY = flag("steps")?.split(",").map((s) => s.trim().toLowerCase());
const WANTED_TOKENS = flag("tokens")?.split(",").map((s) => s.trim().toLowerCase());

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia. " +
      "Load the shared file: set -a; source <ecosystem>/.env.testnet; set +a",
  );
}

/** How much CELO each wallet the run creates is given. */
const FUND_CELO = parseEther(process.env.SPINE_FUND_CELO ?? "0.5");
/** Whole stablecoin units given to each S2b wallet. */
const FUND_TOKEN = process.env.SPINE_FUND_TOKEN ?? "1";
/** Seconds the short-lived key in S5b lives for. Must clear the relay's quote TTL. */
const SHORT_EXPIRY_S = Number(process.env.SPINE_SHORT_EXPIRY ?? 150);

const celoRpc = FORK
  ? (process.env.SPINE_FORK_CELO_RPC ?? "http://127.0.0.1:8545")
  : (process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA.publicRpcUrl);
const sepoliaRpc = FORK
  ? (process.env.SPINE_FORK_SEPOLIA_RPC ?? "http://127.0.0.1:8546")
  : (process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl);

const relayOverride = RELAY_URL ? { relayUrl: RELAY_URL } : {};
const sepolia: NetworkConfig = { ...SEPOLIA, publicRpcUrl: sepoliaRpc, ...relayOverride };
const celo: NetworkConfig = {
  ...CELO_SEPOLIA,
  publicRpcUrl: celoRpc,
  ...relayOverride,
  registry: { kind: "cached", l1: sepolia, keyStoreCache: keyStoreCacheOf(CELO_SEPOLIA) },
};

/** What the report calls the relay this run used. */
const RELAY_LABEL = FORK ? "fork" : RELAY_URL ? `local (${RELAY_URL})` : "railway";
const CACHE = keyStoreCacheOf(celo);

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

const celoPublic: PublicClient = createPublicClient({ chain: celo.chain, transport: http(celo.publicRpcUrl) });
const sepoliaPublic: PublicClient = createPublicClient({ chain: sepolia.chain, transport: http(sepolia.publicRpcUrl) });
const funder = privateKeyToAccount(TEST_FUNDER_KEY);
const celoFunder = createWalletClient({ account: funder, chain: celo.chain, transport: http(celo.publicRpcUrl) });
/** Only ever used in fork mode. */
const anvil = createTestClient({ mode: "anvil", chain: celo.chain, transport: http(celo.publicRpcUrl) });

const client = createClient({ chains: [celo] });

// ---------------------------------------------------------------------------
// The step table
// ---------------------------------------------------------------------------

type StepStatus = "PASS" | "FAIL" | "SKIPPED";
type StepRow = {
  id: string;
  what: string;
  status: StepStatus;
  relay: string;
  txs: { label: string; hash: Hex; chain: "celo" | "sepolia" }[];
  notes: string[];
  error?: string;
  seconds: number;
};

const rows: StepRow[] = [];
const t0 = performance.now();
const ms = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

function explorer(chain: "celo" | "sepolia", hash: Hex) {
  return `${chain === "celo" ? celo.explorer : sepolia.explorer}/tx/${hash}`;
}

/** The handle a step body uses to record what it proved. */
type Ctx = {
  tx: (label: string, hash: Hex | undefined, chain?: "celo" | "sepolia") => void;
  note: (line: string) => void;
};

/**
 * Runs one step, catching everything. A step that throws is FAIL and the run
 * continues; `skipIf` returns a reason string to record SKIPPED instead.
 */
async function step(
  id: string,
  what: string,
  body: (ctx: Ctx) => Promise<void>,
  skipIf?: () => string | undefined,
): Promise<boolean> {
  const started = performance.now();
  const row: StepRow = { id, what, status: "PASS", relay: RELAY_LABEL, txs: [], notes: [], seconds: 0 };
  const ctx: Ctx = {
    tx: (label, hash, chain = "celo") => {
      if (hash) row.txs.push({ label, hash, chain });
    },
    note: (line) => row.notes.push(line),
  };

  const selected = !ONLY || ONLY.includes(id.toLowerCase());
  const skip = !selected ? `not in --steps` : skipIf?.();
  if (skip) {
    row.status = "SKIPPED";
    row.notes.push(skip);
    rows.push(row);
    console.log(`\n[${id}] ${what}\n    SKIPPED: ${skip}`);
    return false;
  }

  console.log(`\n[${id}] ${what}`);
  try {
    await body(ctx);
    row.seconds = (performance.now() - started) / 1000;
    rows.push(row);
    console.log(`    PASS [${ms()}]`);
    return true;
  } catch (err) {
    row.status = "FAIL";
    row.error = err instanceof Error ? err.message : String(err);
    row.seconds = (performance.now() - started) / 1000;
    rows.push(row);
    console.log(`    FAIL: ${row.error.split("\n")[0]!.slice(0, 300)}`);
    return false;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every wallet this run created, so S6 can sweep them all back. */
const created: { address: Address; signer: ReturnType<typeof createPrivateKeySigner>; token?: FeeCurrency }[] = [];

const balanceOf = (token: Address, owner: Address) =>
  celoPublic.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

/**
 * Gives `holder` exactly `amount` of `token` on a fork by finding the
 * balances mapping slot and writing it. Same approach as fork-celo-x402-server.
 */
async function dealToken(token: Address, holder: Address, amount: bigint) {
  for (let slot = 0; slot < 60; slot++) {
    const key = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]),
    );
    await anvil.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
    if ((await balanceOf(token, holder)) === amount) return;
    await anvil.setStorageAt({ address: token, index: key, value: pad("0x0") });
  }
  throw new Error(`could not find the balances slot for ${token} on the fork`);
}

/** Puts `amount` of `token` into `holder`: a transfer live, a storage write on a fork. */
async function fundToken(token: Address, holder: Address, amount: bigint, ctx: Ctx, label: string) {
  if (FORK) {
    await dealToken(token, holder, amount);
    ctx.note(`${label}: balance set on the fork (anvil_setStorageAt)`);
    return;
  }
  const hash = await celoFunder.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [holder, amount],
  });
  await celoPublic.waitForTransactionReceipt({ hash });
  ctx.tx(label, hash);
}

/** A fresh wallet holding `celoAmount` CELO and nothing else. */
async function freshWallet(celoAmount: bigint, ctx: Ctx, label: string) {
  const signer = createPrivateKeySigner();
  const wallet = await client.createWallet({ signer });
  if (celoAmount > 0n) {
    if (FORK) {
      await anvil.setBalance({ address: wallet.address, value: celoAmount });
      ctx.note(`${label}: ${formatEther(celoAmount)} CELO set on the fork`);
    } else {
      const hash = await celoFunder.sendTransaction({ to: wallet.address, value: celoAmount });
      await celoPublic.waitForTransactionReceipt({ hash });
      ctx.tx(label, hash);
    }
  }
  created.push({ address: wallet.address, signer });
  return { wallet, signer };
}

const sendZero = (to: Address) => ({ to, value: 0n, data: "0x" as Hex });

function printLegRows(legs: readonly SessionLeg[], ctx: Ctx) {
  for (const leg of legs) {
    console.log(`    ${describeLeg(leg)}`);
    if (leg.transactionHash) {
      ctx.tx(`${leg.kind} on ${leg.chainId}`, leg.transactionHash, leg.chainId === sepolia.chainId ? "sepolia" : "celo");
    }
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** State shared between steps; each step guards on what it needs. */
const S: {
  wallet?: Awaited<ReturnType<typeof freshWallet>>;
  session?: Session & { keyId: Hex; legs: SessionLeg[]; cacheSync: Promise<SessionLeg[]> };
  registryOk?: boolean;
  cacheOk?: boolean;
  stablecoins: FeeCurrency[];
} = { stablecoins: [] };

async function main() {
  console.log("Altana Celo spine: Celo Sepolia (11142220), KeyStore on Ethereum Sepolia (11155111)");
  console.log("===================================================================================");
  console.log(`relay:   ${RELAY_LABEL}${FORK ? "" : ` -> ${celo.relayUrl}`}`);
  console.log(`celo:    ${celo.publicRpcUrl}`);
  console.log(`sepolia: ${sepolia.publicRpcUrl}`);
  console.log(`cache:   ${CACHE}`);
  console.log(`funder:  ${funder.address}`);

  const [funderCelo, funderSepolia] = await Promise.all([
    celoPublic.getBalance({ address: funder.address }),
    sepoliaPublic.getBalance({ address: funder.address }).catch(() => 0n),
  ]);
  console.log(`         ${formatEther(funderCelo)} CELO, ${formatEther(funderSepolia)} ETH on Sepolia`);
  if (!FORK && funderCelo < parseEther("1")) {
    throw new Error(`Fund ${funder.address} with at least 1 CELO: https://faucet.celo.org/celo-sepolia`);
  }

  // Which stablecoins this relay accepts, and which the funder can actually pay for.
  const currencies = await client.feeCurrencies().catch((e) => {
    console.log(`    feeCurrencies() failed: ${e instanceof Error ? e.message : e}`);
    return { currencies: [] as FeeCurrency[], rateTtl: 0, chainId: celo.chainId };
  });
  console.log(`\nrelay fee tokens (${currencies.currencies.length}):`);
  for (const c of currencies.currencies) {
    console.log(
      `    ${c.symbol.padEnd(6)} ${c.address} dp=${String(c.decimals).padEnd(2)} ` +
        `1 ${c.symbol} = ${formatUnits(c.nativeRate, 18)} CELO${c.isNative ? "  (native)" : ""}`,
    );
  }
  S.stablecoins = currencies.currencies.filter(
    (c) => !c.isNative && (!WANTED_TOKENS || WANTED_TOKENS.includes(c.uid)),
  );

  // -------------------------------------------------------------------------
  // S1: a wallet with CELO and no ETH anywhere
  // -------------------------------------------------------------------------
  await step("S1", "Fresh wallet funded with CELO only; Sepolia ETH asserted 0", async (ctx) => {
    S.wallet = await freshWallet(FUND_CELO, ctx, "fund wallet with CELO");
    const { wallet } = S.wallet;
    console.log(`    wallet ${wallet.address}`);
    const [onCelo, onSepolia] = await Promise.all([
      celoPublic.getBalance({ address: wallet.address }),
      sepoliaPublic.getBalance({ address: wallet.address }),
    ]);
    ctx.note(`wallet ${wallet.address}`);
    ctx.note(`holds ${formatEther(onCelo)} CELO on Celo Sepolia, ${formatEther(onSepolia)} ETH on Sepolia`);
    assert(onCelo === FUND_CELO, `expected ${formatEther(FUND_CELO)} CELO, got ${formatEther(onCelo)}`);
    assert(onSepolia === 0n, `the wallet must start with 0 ETH on Sepolia, holds ${formatEther(onSepolia)}`);
    console.log(`    ${formatEther(onCelo)} CELO on Celo, 0 ETH on Sepolia`);
  });

  // -------------------------------------------------------------------------
  // S2a: execute paying CELO
  // -------------------------------------------------------------------------
  await step(
    "S2a",
    "Execute on Celo paying CELO",
    async (ctx) => {
      const { wallet, signer } = S.wallet!;
      const quote = await client.quoteExecute({
        wallet,
        signer,
        calls: sendZero(funder.address),
        feeToken: NATIVE_TOKEN,
      });
      console.log(`    quoted max fee: ${formatEther(quote.fee)} CELO`);
      ctx.note(`quoted max fee ${formatEther(quote.fee)} CELO (quoteExecute, nothing sent)`);

      const before = await celoPublic.getBalance({ address: wallet.address });
      const res = await client.execute({
        wallet,
        signer,
        calls: sendZero(funder.address),
        feeToken: NATIVE_TOKEN,
      });
      console.log(`    status ${res.status}  tx ${res.transactionHash}`);
      ctx.tx("execute paying CELO", res.transactionHash);
      assert(res.status === "CONFIRMED", `execute status ${res.status}`);
      assert(
        res.feeToken?.toLowerCase() === NATIVE_TOKEN,
        `expected the fee in native CELO, relay charged ${res.feeToken}`,
      );
      const after = await celoPublic.getBalance({ address: wallet.address });
      const paid = before - after;
      console.log(`    charged ${formatEther(paid)} CELO`);
      ctx.note(`charged ${formatEther(paid)} CELO, at or under the ${formatEther(quote.fee)} quoted`);
      assert(paid <= quote.fee, `charged ${formatEther(paid)} CELO, more than the quoted ${formatEther(quote.fee)}`);
    },
    () => (S.wallet ? undefined : "S1 did not produce a wallet"),
  );

  // -------------------------------------------------------------------------
  // S2b: execute paying each stablecoin, one wallet per token
  // -------------------------------------------------------------------------
  for (const currency of S.stablecoins) {
    await step(
      `S2b-${currency.uid}`,
      `Execute paying ${currency.symbol}, from a wallet holding only ${currency.symbol}`,
      async (ctx) => {
        const amount = BigInt(FUND_TOKEN) * 10n ** BigInt(currency.decimals);
        if (!FORK) {
          const held = await balanceOf(currency.address, funder.address);
          assert(
            held >= amount,
            `the funder holds ${formatUnits(held, currency.decimals)} ${currency.symbol}, needs ${FUND_TOKEN}. ` +
              `There is no Mento route into this token from USDC; run with --fork, or have Doris use ` +
              `https://faucet.celo.org/celo-sepolia`,
          );
        }

        // No CELO at all: this is the whole point of the step.
        const { wallet, signer } = await freshWallet(0n, ctx, "create wallet");
        await fundToken(currency.address, wallet.address, amount, ctx, `fund wallet with ${currency.symbol}`);
        console.log(`    wallet ${wallet.address} holds ${FUND_TOKEN} ${currency.symbol}, 0 CELO`);
        const nativeHeld = await celoPublic.getBalance({ address: wallet.address });
        assert(nativeHeld === 0n, `the wallet must hold no CELO, holds ${formatEther(nativeHeld)}`);

        const before = await balanceOf(currency.address, wallet.address);
        // Name no feeToken: the relay must pick the only token the wallet holds.
        const res = await client.execute({ wallet, signer, calls: sendZero(funder.address) });
        console.log(`    status ${res.status}  tx ${res.transactionHash}  feeToken ${res.feeToken}`);
        ctx.tx(`execute paying ${currency.symbol}`, res.transactionHash);
        assert(res.status === "CONFIRMED", `execute status ${res.status}`);
        assert(
          res.feeToken?.toLowerCase() === currency.address.toLowerCase(),
          `expected the fee in ${currency.symbol} (${currency.address}), relay charged ${res.feeToken}`,
        );
        const after = await balanceOf(currency.address, wallet.address);
        console.log(`    charged ${formatUnits(before - after, currency.decimals)} ${currency.symbol}`);
        ctx.note(
          `charged ${formatUnits(before - after, currency.decimals)} ${currency.symbol}; ` +
            `CELO balance still ${formatEther(await celoPublic.getBalance({ address: wallet.address }))}`,
        );
        created[created.length - 1]!.token = currency;
      },
    );
  }

  // -------------------------------------------------------------------------
  // S3: register the session key in the Sepolia KeyStore, paid from Celo
  // -------------------------------------------------------------------------
  await step(
    "S3",
    "Register a session key in the Sepolia KeyStore, paid from the Celo balance",
    async (ctx) => {
      const { wallet, signer } = S.wallet!;
      const beforeSepolia = await sepoliaPublic.getBalance({ address: wallet.address });
      assert(beforeSepolia === 0n, `the wallet must hold 0 ETH on Sepolia before the write, holds ${formatEther(beforeSepolia)}`);

      // populateCache: false here so S3 proves only the registry write; S4
      // does the proof on its own and can fail without taking S3 with it.
      const session = await client.grantSession({
        wallet,
        signer,
        permissions: {
          calls: [{ to: funder.address }],
          spend: [{ limit: parseEther("1"), period: "day" }],
        },
        expiry: Math.floor(Date.now() / 1000) + 3600,
        register: true,
        populateCache: false,
        onStatus: (s, d) => console.log(`    ${s}${d ? ` (chain ${d.chainId})` : ""} [${ms()}]`),
      });
      S.session = session as typeof S.session;
      printLegRows(session.legs, ctx);
      assert(session.status === "granted", `grantSession status ${session.status}`);

      const registry = legOf(session.legs, "registry", sepolia.chainId);
      assert(registry.status === "CONFIRMED", `registry write ${registry.status}: ${registry.reason ?? ""}`);
      assert(
        registry.fundedFromChainId === celo.chainId,
        `the Sepolia write was not funded from Celo Sepolia (fundedFromChainId=${registry.fundedFromChainId}). ` +
          `This is the interop path: a relay without PR #25 cannot do it.`,
      );
      ctx.note(`registry write funded from chain ${registry.fundedFromChainId} (Celo Sepolia), source tx ${registry.sourceTransactionHash}`);
      ctx.tx("registry write source (Celo)", registry.sourceTransactionHash, "celo");

      const valid = await sepoliaPublic.readContract({
        address: sepolia.keyStore,
        abi: KEYSTORE_ABI,
        functionName: "isValidKey",
        args: [wallet.address, session.keyId],
      });
      console.log(`    Sepolia KeyStore.isValidKey = ${valid}`);
      assert(valid, "the key is not valid on the Sepolia KeyStore");
      ctx.note(`Sepolia KeyStore.isValidKey(${wallet.address}, ${session.keyId}) = true`);

      // The wallet never SPENDS Sepolia ETH. The relay refunds the unspent part
      // of its quoted maximum onto Sepolia, so a non-zero balance here is the
      // change from a write Celo paid for, not ETH the wallet had to hold.
      const afterSepolia = await sepoliaPublic.getBalance({ address: wallet.address });
      console.log(`    Sepolia ETH: 0 before, ${formatEther(afterSepolia)} after (relay change, never a prerequisite)`);
      ctx.note(`Sepolia ETH 0 before the write, ${formatEther(afterSepolia)} after: unspent change refunded by the relay`);
      S.registryOk = true;
    },
    () => (S.wallet ? undefined : "S1 did not produce a wallet"),
  );

  // -------------------------------------------------------------------------
  // S4: the cache proof into the Celo mirror
  // -------------------------------------------------------------------------
  await step(
    "S4",
    "Prove the key into the Celo mirror (KeyStoreCache) and read it back",
    async (ctx) => {
      const { wallet, signer } = S.wallet!;
      const session = S.session!;
      // The mirror's L1 anchor moves about every 20 minutes, so allow 30.
      const legs = await client.syncSessionToCache({ wallet, signer, session });
      printLegRows(legs, ctx);
      const cacheLeg = legOf(legs, "cache", celo.chainId);
      assert(cacheLeg.status === "CONFIRMED", `cache proof ${cacheLeg.status}: ${cacheLeg.reason ?? ""}`);
      console.log(`    anchored at Sepolia block ${cacheLeg.l1BlockNumber}`);
      ctx.note(`proof anchored at Sepolia (L1) block ${cacheLeg.l1BlockNumber}`);

      const cached = await readCachedKey(celoPublic, CACHE, wallet.address, session.keyId);
      const fresh = await isCachedKeyValid(celoPublic, CACHE, wallet.address, session.keyId);
      console.log(`    cache.getCachedKey: revoked=${cached.revoked}  isCachedKeyValid=${fresh}`);
      assert(
        cached.publicKey.toLowerCase() === session.publicKey.toLowerCase(),
        "the mirror does not hold this session's public key",
      );
      assert(!cached.revoked, "the mirror reports the key as revoked before any revocation");
      ctx.note(`Celo mirror ${CACHE}: key present, revoked=false, isCachedKeyValid=${fresh}`);
      S.cacheOk = true;
    },
    () => (S.registryOk ? undefined : "S3 did not register the key"),
  );

  // -------------------------------------------------------------------------
  // S5a: use the session key
  // -------------------------------------------------------------------------
  await step(
    "S5a",
    "Execute as the session key",
    async (ctx) => {
      const res = await client.execute({ session: S.session!, calls: sendZero(funder.address) });
      console.log(`    status ${res.status}  tx ${res.transactionHash}`);
      ctx.tx("session execute", res.transactionHash);
      assert(res.status === "CONFIRMED", `session execute status ${res.status}`);
      ctx.note(`the session key transacted; fee charged in ${res.feeToken}`);
    },
    () => (S.session ? undefined : "S3 did not produce a session"),
  );

  // -------------------------------------------------------------------------
  // S5b: a short-lived key is rejected once it expires
  // -------------------------------------------------------------------------
  await step(
    "S5b",
    `A key with a ${SHORT_EXPIRY_S}s timebox is rejected after it expires`,
    async (ctx) => {
      const { wallet, signer } = S.wallet!;
      const expiry = Math.floor(Date.now() / 1000) + SHORT_EXPIRY_S;
      // register: false keeps this independent of the KeyStore: the account
      // alone enforces expiry, which is exactly what this step tests.
      const shortLived = await client.grantSession({
        wallet,
        signer,
        permissions: {
          calls: [{ to: funder.address }],
          spend: [{ limit: parseEther("0.1"), period: "day" }],
        },
        expiry,
        register: false,
        populateCache: false,
      });
      assert(shortLived.status === "granted", `short-lived grant status ${shortLived.status}`);
      printLegRows(shortLived.legs, ctx);
      ctx.note(`granted a key expiring at unix ${expiry}`);

      // It works now.
      const before = await client.execute({ session: shortLived, calls: sendZero(funder.address) });
      console.log(`    before expiry: ${before.status}  tx ${before.transactionHash}`);
      ctx.tx("session execute before expiry", before.transactionHash);
      assert(before.status === "CONFIRMED", `the short-lived key failed before its expiry: ${before.status}`);

      // Wait it out. The account compares against the block timestamp, so wait
      // past the expiry and then until a block carries a later timestamp.
      const waitMs = (expiry - Math.floor(Date.now() / 1000) + 15) * 1000;
      console.log(`    waiting ${Math.round(waitMs / 1000)}s for the timebox to expire...`);
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));
      for (let i = 0; i < 30; i++) {
        const b = await celoPublic.getBlock();
        if (Number(b.timestamp) > expiry) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
      const chainNow = Number((await celoPublic.getBlock()).timestamp);
      console.log(`    chain time ${chainNow} is past the ${expiry} expiry by ${chainNow - expiry}s`);
      ctx.note(`chain time ${chainNow}, ${chainNow - expiry}s past the expiry`);

      // And now it must not.
      let rejected = false;
      let how = "";
      try {
        const after = await client.execute({ session: shortLived, calls: sendZero(funder.address) });
        if (after.status !== "CONFIRMED") {
          rejected = true;
          how = `execute returned ${after.status}`;
          ctx.tx("session execute after expiry (rejected)", after.transactionHash);
        }
      } catch (err) {
        rejected = true;
        how = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
      }
      console.log(`    after expiry: ${rejected ? `rejected (${how})` : "STILL WORKS"}`);
      assert(rejected, "the expired key still executed: the timebox was not enforced");
      ctx.note(`after expiry the key was rejected: ${how}`);
    },
    () => (S.wallet ? undefined : "S1 did not produce a wallet"),
  );

  // -------------------------------------------------------------------------
  // S5c: revoke, then rejection, then the mirror shows it revoked
  // -------------------------------------------------------------------------
  await step(
    "S5c",
    "Revoke the session key: execute rejected, and the mirror shows it revoked",
    async (ctx) => {
      const { wallet, signer } = S.wallet!;
      const session = S.session!;
      const res = await client.revokeSession({
        wallet,
        signer,
        session,
        onStatus: (s, d) => console.log(`    ${s}${d ? ` (chain ${d.chainId})` : ""} [${ms()}]`),
      });
      printLegRows(res.legs, ctx);
      assert(res.status === "revoked", `revokeSession status ${res.status}`);
      assert(
        legOf(res.legs, "account", celo.chainId).status === "CONFIRMED",
        "the account revoke did not confirm",
      );

      // The key must stop working, whatever the mirror says.
      let rejected = false;
      let how = "";
      try {
        const after = await client.execute({ session, calls: sendZero(funder.address) });
        if (after.status !== "CONFIRMED") {
          rejected = true;
          how = `execute returned ${after.status}`;
        }
      } catch (err) {
        rejected = true;
        how = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
      }
      console.log(`    after revoke: ${rejected ? `rejected (${how})` : "STILL WORKS"}`);
      assert(rejected, "the revoked key still executed");
      ctx.note(`after revoke the key was rejected: ${how}`);

      // The mirror is the third-party-verifiable record; it may lag the relay.
      if (!S.cacheOk) {
        ctx.note("mirror check skipped: S4 never proved the key in, so there is nothing to see revoked");
        return;
      }
      let cached = await readCachedKey(celoPublic, CACHE, wallet.address, session.keyId);
      for (let i = 0; i < 20 && !cached.revoked; i++) {
        await new Promise((r) => setTimeout(r, 3_000));
        cached = await readCachedKey(celoPublic, CACHE, wallet.address, session.keyId);
      }
      console.log(`    mirror after revoke: revoked=${cached.revoked}`);
      assert(cached.revoked, "the mirror still reports the key as live after the post-revocation proof");
      ctx.note(`Celo mirror ${CACHE}: revoked=true`);
    },
    () => (S.session ? undefined : "S3 did not produce a session"),
  );

  // -------------------------------------------------------------------------
  // S6: refund the funder. Always runs, whatever failed above.
  // -------------------------------------------------------------------------
  await step(
    "S6",
    "Refund every wallet this run created back to the funder",
    async (ctx) => {
      if (FORK) {
        ctx.note("fork mode: nothing to refund, the chain is thrown away");
        return;
      }
      let swept = 0;
      for (const w of created) {
        // Tokens first: a token wallet holds no CELO, so the relay pays itself
        // from the token, which is the only way the balance can come home.
        if (w.token) {
          const held = await balanceOf(w.token.address, w.address);
          if (held > 0n) {
            try {
              const res = await client.execute({
                wallet: { address: w.address },
                signer: w.signer,
                calls: {
                  to: w.token.address,
                  value: 0n,
                  data: `0xa9059cbb${funder.address.slice(2).padStart(64, "0")}${held.toString(16).padStart(64, "0")}` as Hex,
                },
              });
              ctx.tx(`return ${w.token.symbol} from ${w.address.slice(0, 10)}`, res.transactionHash);
              swept++;
            } catch (err) {
              ctx.note(`could not return ${w.token.symbol} from ${w.address}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
            }
          }
          continue;
        }
        const bal = await celoPublic.getBalance({ address: w.address });
        if (bal === 0n) continue;
        // Leave enough for the relay's fee; send the rest, sized from a quote.
        try {
          const quote = await client.quoteExecute({
            wallet: { address: w.address },
            signer: w.signer,
            calls: { to: funder.address, value: 1n, data: "0x" },
            feeToken: NATIVE_TOKEN,
          });
          const send = bal > quote.fee * 2n ? bal - quote.fee * 2n : 0n;
          if (send === 0n) {
            ctx.note(`${w.address} holds ${formatEther(bal)} CELO, under the fee: left as dust`);
            continue;
          }
          const res = await client.execute({
            wallet: { address: w.address },
            signer: w.signer,
            calls: { to: funder.address, value: send, data: "0x" },
            feeToken: NATIVE_TOKEN,
          });
          ctx.tx(`return ${formatEther(send)} CELO from ${w.address.slice(0, 10)}`, res.transactionHash);
          swept++;
        } catch (err) {
          ctx.note(`could not sweep ${w.address}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        }
      }
      ctx.note(`${swept} of ${created.length} wallets returned their balance`);
      console.log(`    swept ${swept}/${created.length}`);
    },
    () => (KEEP ? "--keep: wallets left funded on purpose" : undefined),
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function report(): string {
  const date = new Date().toISOString().slice(0, 10);
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const skip = rows.filter((r) => r.status === "SKIPPED").length;

  const out: string[] = [];
  out.push(`# Celo spine run, ${date}`);
  out.push("");
  out.push(`- Relay: **${RELAY_LABEL}**${FORK ? "" : ` (\`${celo.relayUrl}\`)`}`);
  out.push(`- Celo Sepolia RPC: \`${celo.publicRpcUrl}\``);
  out.push(`- Sepolia RPC: \`${sepolia.publicRpcUrl}\``);
  out.push(`- Mirror (KeyStoreCache): \`${CACHE}\``);
  out.push(`- Funder: \`${funder.address}\``);
  out.push(`- Result: **${pass} passed, ${fail} failed, ${skip} skipped** in ${ms()}`);
  out.push("");
  out.push("| Step | What | Result | Relay |");
  out.push("|---|---|---|---|");
  for (const r of rows) {
    const mark = r.status === "PASS" ? "**PASS**" : r.status === "FAIL" ? "**FAIL**" : "skipped";
    out.push(`| ${r.id} | ${r.what} | ${mark} | ${r.status === "SKIPPED" ? "-" : r.relay} |`);
  }
  out.push("");
  for (const r of rows) {
    out.push(`## ${r.id} — ${r.what}`);
    out.push("");
    out.push(`**${r.status}**${r.status === "SKIPPED" ? "" : ` in ${r.seconds.toFixed(1)}s on ${r.relay}`}`);
    out.push("");
    if (r.error) {
      out.push("Error:");
      out.push("");
      out.push("```");
      out.push(r.error.slice(0, 2000));
      out.push("```");
      out.push("");
    }
    for (const n of r.notes) out.push(`- ${n}`);
    if (r.txs.length) {
      out.push("");
      out.push("| Tx | Chain | Hash |");
      out.push("|---|---|---|");
      for (const t of r.txs) {
        out.push(`| ${t.label} | ${t.chain === "celo" ? "Celo Sepolia" : "Sepolia"} | [\`${t.hash.slice(0, 18)}…\`](${explorer(t.chain, t.hash)}) |`);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

function printTable() {
  console.log("\n===================================================================================");
  console.log("Spine result");
  console.log("===================================================================================");
  const w = Math.max(...rows.map((r) => r.what.length), 4);
  for (const r of rows) {
    const mark = r.status === "PASS" ? "PASS   " : r.status === "FAIL" ? "FAIL   " : "SKIPPED";
    console.log(`${r.id.padEnd(10)} ${mark}  ${r.what.padEnd(w)}  ${r.status === "SKIPPED" ? "" : r.relay}`);
    for (const t of r.txs) console.log(`${" ".repeat(10)}         ${t.label}: ${explorer(t.chain, t.hash)}`);
    if (r.error) console.log(`${" ".repeat(10)}         ! ${r.error.split("\n")[0]!.slice(0, 200)}`);
  }
  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const skip = rows.filter((r) => r.status === "SKIPPED").length;
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped in ${ms()}`);
}

const evidenceDir =
  process.env.SPINE_EVIDENCE_DIR ??
  new URL("../../../../evidence/", import.meta.url).pathname;

async function writeReport() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tag = FORK ? "fork" : RELAY_URL ? "local" : "railway";
  const file = `${evidenceDir.replace(/\/$/, "")}/${new Date().toISOString().slice(0, 10)}-spine-${tag}-${stamp.slice(11)}.md`;
  try {
    await Bun.write(file, report());
    console.log(`\nReport: ${file}`);
  } catch (err) {
    console.log(`\nCould not write the report to ${file}: ${err instanceof Error ? err.message : err}`);
    console.log(report());
  }
}

main()
  .catch((err) => {
    console.error("\nThe spine run could not start:", err);
    rows.push({
      id: "setup",
      what: "Start the run",
      status: "FAIL",
      relay: RELAY_LABEL,
      txs: [],
      notes: [],
      error: err instanceof Error ? err.message : String(err),
      seconds: 0,
    });
  })
  .then(async () => {
    printTable();
    await writeReport();
    process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
  });
