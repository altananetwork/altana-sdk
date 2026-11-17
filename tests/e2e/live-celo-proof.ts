/**
 * The live proof for Celo: a wallet that holds only CELO sets itself up and
 * uses a session, and everything happens on Celo.
 *
 *   1. quote    what the first grant will cost, before anything is signed
 *   2. grant    the wallet's first action: the main key and the session key
 *               are registered in Celo's KeyStore and the session is
 *               authorized, in one request
 *   3. use      the session sends a transaction
 *   4. revoke   the key is no longer valid in the KeyStore, and the session
 *               is refused
 *   5. grant    a second session: one more key. Skipped, and said so, when
 *               the wallet cannot pay for it
 *   6. revoke   the second session too, so the run leaves nothing usable
 *   7. cost     what the wallet paid at each step, in CELO and in dollars at
 *               the price the KeyStore controller reads, split into
 *               registration fees and relay fees, against the $2 target for
 *               a first setup
 *
 * WITHOUT `--send` THIS IS A DRY RUN: it reads, quotes and prints, and signs
 * and sends nothing.
 *
 *   --network celo-sepolia   (default) a throwaway wallet, funded from
 *                            TEST_FUNDER_KEY. Its key is saved to the shared
 *                            testnet env file before it holds anything, and
 *                            what is left goes back to the funder.
 *   --network celo           the wallet of MAINNET_TEST_CELO_KEY. A send also
 *                            needs `--i-am-doris` and a phrase typed at an
 *                            interactive terminal: it spends real funds, and
 *                            only the owner runs it. Nothing is funded and
 *                            nothing is swept.
 *
 * Keys come from the environment and are never printed:
 *   set -a; source <ecosystem>/.env.testnet; set +a     (celo-sepolia)
 *   set -a; source <ecosystem>/.env.mainnet; set +a     (celo)
 * Optional: CELO_SEPOLIA_RPC_URL / CELO_MAINNET_RPC_URL for this script's own
 * reads, SMOKE_CELO_FEE_HEADROOM (celo-sepolia: CELO sent on top of the three
 * registrations for the relay's fees, default 1.6).
 *
 * Run (from tests/e2e):
 *   bun run live:celo-proof
 *   bun run live:celo-proof -- --send
 *   bun run live:celo-proof -- --network celo
 *   bun run live:celo-proof -- --network celo --send --i-am-doris
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  createClient,
  formatQuoteLine,
  isCachedRegistry,
  signerFromPrivateKey,
  CELO,
  CELO_SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readActiveKeys, readIsValidKey, readRegistrationFee, registrationValueFor } from "../../packages/wallet/src/internal/keystore.js";
import { assertStatus, legOf, printLegs } from "./session-legs.js";
import { testnetEnvFile } from "./testnet-env.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const which = (option("--network") ?? "celo-sepolia").toLowerCase();
if (which !== "celo-sepolia" && which !== "celo") throw new Error(`unknown --network "${which}": use celo-sepolia or celo`);
const MAINNET = which === "celo";
const SEND = flag("--send");

const base = MAINNET ? CELO : CELO_SEPOLIA;
const rpcOverride = MAINNET ? process.env.CELO_MAINNET_RPC_URL : process.env.CELO_SEPOLIA_RPC_URL;
const network: NetworkConfig = { ...base, ...(rpcOverride ? { publicRpcUrl: rpcOverride } : {}) };
const CHAIN_ID = network.chainId;
const NAME = network.chain.name;
const SYMBOL = network.chain.nativeCurrency.symbol;
/** What a first setup (main key, session key, the relay's fee) should stay under, in dollars. */
const FIRST_SETUP_TARGET_USD = 2;
const CONFIRM_PHRASE = "spend real CELO";

const VERSION_ABI = [{ name: "VERSION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
const CONTROLLER_ABI = [{ name: "priceFeed", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const FEED_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
  },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const t0 = performance.now();
const ms = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`    ok: ${what}`);
}
/**
 * A check on chain state made right after a write. A public RPC is often
 * load-balanced, and a node that has not seen the write's block yet answers
 * with the state before it. So the read is repeated until it shows the
 * expected state, for up to 30 seconds.
 */
async function settles(read: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await read().catch(() => false)) return check(true, what);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  check(false, what);
}

/** One row of the cost table: what the wallet's CELO balance lost in a step, and how much of it was registration fees. */
type Row = { step: string; transactionHash?: Hex; paid: bigint; registrations: bigint };

async function main() {
  console.log(`@altananetwork/sdk live proof: ${NAME} (chain ${CHAIN_ID}), ${SEND ? "SENDING" : "dry run"}`);
  console.log("=".repeat(72));
  const pub: PublicClient = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });

  // The contracts and the price.
  console.log("\n[0] the KeyStore the SDK points at");
  check(!isCachedRegistry(network), `${NAME} keeps its own KeyStore in the SDK config`);
  const [ksCode, ctCode] = await Promise.all([pub.getCode({ address: network.keyStore }), pub.getCode({ address: network.keyStoreController })]);
  check(ksCode && ksCode !== "0x", `the KeyStore is deployed at ${network.keyStore}`);
  check(ctCode && ctCode !== "0x", `the controller is deployed at ${network.keyStoreController}`);
  const [ksVersion, ctVersion] = await Promise.all([
    pub.readContract({ address: network.keyStore, abi: VERSION_ABI, functionName: "VERSION" }),
    pub.readContract({ address: network.keyStoreController, abi: VERSION_ABI, functionName: "VERSION" }),
  ]);
  console.log(`    KeyStore ${ksVersion}, controller ${ctVersion}`);
  const fee = await readRegistrationFee(pub, network);
  const feed = await pub.readContract({ address: network.keyStoreController, abi: CONTROLLER_ABI, functionName: "priceFeed" });
  const [round, feedDecimals] = await Promise.all([
    pub.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" }),
    pub.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" }),
  ]);
  const price = Number(round[1]) / 10 ** feedDecimals;
  const usd = (wei: bigint) => `$${(Number(formatEther(wei)) * price).toFixed(4)}`;
  console.log(`    ${SYMBOL} price the controller reads: $${price}; registration fee ${formatEther(fee)} ${SYMBOL} per key (${usd(fee)})`);

  // The wallet.
  console.log("\n[1] the wallet");
  const client = createClient({ chains: [network] });
  let adminKey: Hex;
  let funder: ReturnType<typeof privateKeyToAccount> | undefined;
  if (MAINNET) {
    adminKey = process.env.MAINNET_TEST_CELO_KEY as Hex;
    if (!adminKey) throw new Error("Set MAINNET_TEST_CELO_KEY (set -a; source <ecosystem>/.env.mainnet; set +a).");
  } else {
    const funderKey = process.env.TEST_FUNDER_KEY as Hex;
    if (!funderKey) throw new Error("Set TEST_FUNDER_KEY (set -a; source <ecosystem>/.env.testnet; set +a).");
    funder = privateKeyToAccount(funderKey);
    adminKey = generatePrivateKey();
  }
  const admin = signerFromPrivateKey(adminKey);
  // The wallet's address is its key's address. Nothing is created yet: a dry run signs nothing.
  const wallet = { address: privateKeyToAccount(adminKey).address };
  const balanceOf = () => pub.getBalance({ address: wallet.address });
  const firstSetupValue = registrationValueFor(fee) * 2n;
  console.log(`    ${wallet.address}, holding ${formatEther(await balanceOf())} ${SYMBOL}`);
  console.log(`    a first setup sends ${formatEther(firstSetupValue)} ${SYMBOL} with the request (two registrations with the SDK's margin, which comes back), plus the relay's fee`);

  const keysBefore = (await readActiveKeys(pub, network, wallet.address)).length;
  console.log(`    keys the KeyStore already holds for it: ${keysBefore}`);

  // The quote needs a wallet that exists and can pay, so a dry run on the
  // testnet stops here: its throwaway wallet is only created by a send.
  if (!MAINNET && !SEND) {
    console.log("\nDry run: nothing was signed or sent. A throwaway wallet is created and funded with --send.");
    return;
  }
  const code = await pub.getCode({ address: wallet.address });
  const setUp = Boolean(code && code !== "0x");
  if (MAINNET && !setUp && !SEND) {
    console.log(`\nDry run: the wallet is not set up on ${NAME} yet, so there is nothing to quote. A send sets it up first.`);
    return;
  }
  if (MAINNET && SEND) await confirmMainnet(wallet.address);
  if (!setUp) {
    const created = await client.createWallet({ signer: admin });
    check(created.address.toLowerCase() === wallet.address.toLowerCase(), "the wallet is set up at its key's address");
  }

  // Fund a throwaway testnet wallet. Its key is on file before it holds anything.
  if (!MAINNET) {
    const budget = registrationValueFor(fee) * 3n + parseEther(process.env.SMOKE_CELO_FEE_HEADROOM ?? "1.6");
    const funderBalance = await pub.getBalance({ address: funder!.address });
    if (funderBalance < budget + parseEther("0.02")) {
      throw new Error(`Fund ${funder!.address} with at least ${formatEther(budget + parseEther("0.02"))} ${SYMBOL} on ${NAME}: https://faucet.celo.org/celo-sepolia`);
    }
    const tag = wallet.address.slice(2, 10).toUpperCase();
    appendFileSync(testnetEnvFile(), `\nPROOF_CELO_${tag}_KEY=${adminKey}\n`);
    const funderWallet = createWalletClient({ account: funder!, chain: network.chain, transport: http(network.publicRpcUrl) });
    const fundTx = await funderWallet.sendTransaction({ to: wallet.address, value: budget });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    await settles(async () => (await balanceOf()) >= budget, `funded with ${formatEther(budget)} ${SYMBOL} (key saved as PROOF_CELO_${tag}_KEY)`);
  }

  // The session may only call the wallet itself, for an hour. Its cap pays the
  // relay's fee for its own transactions, which the testnet relay quotes at a
  // few tenths of a CELO.
  const permissions = { calls: [{ to: wallet.address }], spend: [{ limit: parseEther("1"), period: "day" as const }] };
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const firstSigner = signerFromPrivateKey(generatePrivateKey());

  console.log("\n[2] quote the first grant");
  const quote = await client.quoteGrantSession({ wallet, signer: admin, sessionSigner: firstSigner, permissions, expiry, chainId: CHAIN_ID });
  for (const line of quote.lines) console.log(`    ${formatQuoteLine(line, network).split("\n")[0]}`);
  check(quote.lines.every((l) => l.chainId === CHAIN_ID), `every quoted line is on ${NAME}`);
  const registrationsQuoted = keysBefore === 0 ? 2n : 1n;
  check(
    quote.lines.some((l) => l.kind === "account" && l.value === registrationValueFor(fee) * registrationsQuoted),
    `the grant's line carries ${registrationsQuoted === 2n ? "both registrations (main key and session key)" : "the session key's registration"}`,
  );
  const short = quote.balances.filter((b) => !b.sufficient);
  for (const b of short) console.log(`    short: ${b.reason ?? `${b.symbol} on chain ${b.chainId}`}`);
  check(short.length === 0, "the wallet can pay what the quote asks");

  if (!SEND) {
    console.log("\nDry run: nothing was signed or sent. Add --send to run the proof.");
    return;
  }

  const rows: Row[] = [];
  /** Runs one step and records what the wallet's balance lost in it. */
  async function step<T>(name: string, registrations: bigint, run: () => Promise<T>, hashOf: (r: T) => Hex | undefined): Promise<T> {
    const before = await balanceOf();
    const result = await run();
    // Every step costs the wallet something; a node that has not seen the step yet still reports `before`.
    let after = await balanceOf();
    for (let i = 0; i < 20 && after >= before; i++) {
      await new Promise((r) => setTimeout(r, 1_500));
      after = await balanceOf();
    }
    rows.push({ step: name, transactionHash: hashOf(result), paid: before - after, registrations: fee * registrations });
    return result;
  }

  try {
    console.log("\n[3] grantSession (the first action: keys registered and session authorized, one request)");
    const first = await step(
      "first grant",
      registrationsQuoted,
      () => client.grantSession({ wallet, signer: admin, sessionSigner: firstSigner, permissions, expiry, chainId: CHAIN_ID }),
      (r) => r.transactionHash,
    );
    printLegs(first.legs);
    assertStatus(first, "granted", "first grant");
    check(first.legs.every((l) => l.chainId === CHAIN_ID), `every leg is on ${NAME}`);
    check(legOf(first.legs, "registry", CHAIN_ID).via === "bundled", "the registration rides in the account's own request");
    check(!first.legs.some((l) => l.kind === "cache"), "there is no mirror step");
    await settles(async () => (await readActiveKeys(pub, network, wallet.address)).length === keysBefore + Number(registrationsQuoted), `the KeyStore holds ${keysBefore + Number(registrationsQuoted)} keys for the wallet`);
    await settles(() => readIsValidKey(pub, network, wallet.address, first.keyId), "the session key is valid in the KeyStore");
    console.log(`    ${network.explorer}/tx/${first.transactionHash} [${ms()}]`);

    console.log("\n[4] execute(session)");
    const used = await step("session transaction", 0n, () => client.execute({ session: first, calls: { to: wallet.address, value: 0n, data: "0x" } }), (r) => r.transactionHash);
    check(used.status === "CONFIRMED", "the session's transaction confirmed");
    console.log(`    ${network.explorer}/tx/${used.transactionHash} [${ms()}]`);

    console.log("\n[5] revokeSession (first session)");
    const revoked = await step("revoke", 0n, () => client.revokeSession({ wallet, signer: admin, session: first }), (r) => r.transactionHash);
    printLegs(revoked.legs);
    assertStatus(revoked, "revoked", "revoke");
    check(revoked.legs.every((l) => l.chainId === CHAIN_ID), `the revoke acted on ${NAME} only`);
    await settles(async () => !(await readIsValidKey(pub, network, wallet.address, first.keyId)), "the revoked key is no longer valid in the KeyStore");
    let afterRevoke = "refused";
    try {
      afterRevoke = (await client.execute({ session: first, calls: { to: wallet.address, value: 0n, data: "0x" } })).status;
    } catch {
      /* refused, as it should be */
    }
    check(afterRevoke !== "CONFIRMED", "the revoked session can no longer transact");
    console.log(`    ${network.explorer}/tx/${revoked.transactionHash} [${ms()}]`);

    console.log("\n[6] grantSession (a second session: one more key)");
    const secondSigner = signerFromPrivateKey(generatePrivateKey());
    const secondQuote = await client.quoteGrantSession({ wallet, signer: admin, sessionSigner: secondSigner, permissions, expiry, chainId: CHAIN_ID });
    const secondShort = secondQuote.balances.filter((b) => !b.sufficient);
    if (secondShort.length > 0) {
      // A step the wallet cannot pay for is an outcome, not a failure of the proof.
      console.log(`    not run: the wallet holds ${formatEther(await balanceOf())} ${SYMBOL}, and one more key needs ${formatEther(registrationValueFor(fee))} ${SYMBOL} with the request plus the relay's fee`);
      for (const b of secondShort) if (b.reason) console.log(`    ${b.reason}`);
    } else {
      const second = await step(
        "second grant",
        1n,
        () => client.grantSession({ wallet, signer: admin, sessionSigner: secondSigner, permissions, expiry, chainId: CHAIN_ID }),
        (r) => r.transactionHash,
      );
      printLegs(second.legs);
      assertStatus(second, "granted", "second grant");
      await settles(() => readIsValidKey(pub, network, wallet.address, second.keyId), "the second session key is valid in the KeyStore");
      console.log(`    ${network.explorer}/tx/${second.transactionHash} [${ms()}]`);

      console.log("\n[7] revokeSession (second session)");
      const revokedSecond = await step("revoke the second", 0n, () => client.revokeSession({ wallet, signer: admin, session: second }), (r) => r.transactionHash);
      assertStatus(revokedSecond, "revoked", "second revoke");
      await settles(async () => !(await readIsValidKey(pub, network, wallet.address, second.keyId)), "no session key of this run is valid anymore");
      console.log(`    ${network.explorer}/tx/${revokedSecond.transactionHash} [${ms()}]`);
    }
  } finally {
    printCosts(rows, usd, price, registrationsQuoted === 2n);
    if (!MAINNET) await sweep(pub, adminKey, wallet.address, funder!.address);
  }
  console.log(`\nPASS [${ms()}]`);
}

/** The cost table, and the first setup against its target. */
function printCosts(rows: Row[], usd: (wei: bigint) => string, price: number, firstSetup: boolean) {
  if (rows.length === 0) return;
  console.log(`\n[cost] what the wallet paid, at $${price} per ${SYMBOL}`);
  for (const r of rows) {
    const relay = r.paid - r.registrations;
    console.log(
      `    ${r.step.padEnd(20)} ${formatEther(r.paid).padStart(22)} ${SYMBOL} (${usd(r.paid)}): ` +
        `registration ${usd(r.registrations)}, relay ${usd(relay)}${r.transactionHash ? `  ${r.transactionHash}` : ""}`,
    );
  }
  const first = rows.find((r) => r.step === "first grant");
  if (first && firstSetup) {
    const dollars = Number(formatEther(first.paid)) * price;
    console.log(`    first setup: $${dollars.toFixed(4)} against the $${FIRST_SETUP_TARGET_USD} target: ${dollars <= FIRST_SETUP_TARGET_USD ? "within it" : "ABOVE IT"}`);
  }
}

/** A send on mainnet spends real funds: the owner asks for it twice, the second time by typing a phrase. */
async function confirmMainnet(address: Address) {
  if (!flag("--i-am-doris")) throw new Error("A send on Celo mainnet spends real funds: add --i-am-doris. Nothing was sent.");
  if (!process.stdin.isTTY) throw new Error("A send on Celo mainnet needs an interactive terminal. Nothing was sent.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nThis spends real CELO from ${address} on Celo mainnet. Type "${CONFIRM_PHRASE}" to continue: `);
  rl.close();
  if (answer.trim() !== CONFIRM_PHRASE) throw new Error("Not confirmed. Nothing was sent.");
}

/** Sends what is left in a testnet wallet back to the funder, as a plain transfer from the wallet's own key. */
async function sweep(pub: PublicClient, adminKey: Hex, wallet: Address, funder: Address) {
  console.log(`\n[sweep] return leftover ${SYMBOL} to the funder`);
  try {
    const account = privateKeyToAccount(adminKey);
    const walletClient = createWalletClient({ account, chain: network.chain, transport: http(network.publicRpcUrl) });
    const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: wallet }), pub.getGasPrice()]);
    // A delegated account runs code when it receives, not when it sends; a generous gas limit covers the transfer.
    const gas = 60_000n;
    const cost = gas * gasPrice * 2n;
    if (balance <= cost) {
      console.log(`    ${formatEther(balance)} ${SYMBOL} left: less than a transfer costs, nothing to return`);
      return;
    }
    const hash = await walletClient.sendTransaction({ to: funder, value: balance - cost, gas, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice / 10n });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(balance - cost)} ${SYMBOL} (${hash})`);
  } catch (err) {
    console.log(`    could not return the leftover: ${(err as Error).message.split("\n")[0]}. The wallet's key is in the testnet env file.`);
  }
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
