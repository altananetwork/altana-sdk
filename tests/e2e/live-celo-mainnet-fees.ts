/**
 * The live proof that a Celo wallet can pay the relay's fee in each currency
 * the relay accepts: one transaction per currency, each with its fee charged
 * in that currency.
 *
 *   0. list     the fee currencies the relay offers on Celo, with their rates
 *   1. wallet   the wallet of MAINNET_TEST_CELO_KEY and what it holds of each
 *   2. quote    what one transaction costs in each currency the wallet holds
 *   3. send     (with --send) one transaction per currency, fee paid in it;
 *               the wallet's balance of that currency drops by the fee, and
 *               the relay reports the same currency back
 *
 * WITHOUT `--send` THIS IS A DRY RUN: it reads, quotes and prints, and signs
 * and sends nothing. A send also needs `--i-am-doris` and a phrase typed at an
 * interactive terminal: it spends real funds, and only the owner runs it.
 *
 *   --tokens usdc,usdt   only these currencies (by symbol, any case; USD₮ is
 *                        also accepted as usdt, USA₮ as usat). Default: every
 *                        non-native currency the relay lists.
 *
 * The wallet must already be set up on Celo (`live:celo-proof` does that).
 * Keys come from the environment and are never printed:
 *   set -a; source <ecosystem>/.env.mainnet; set +a
 * Optional: CELO_MAINNET_RPC_URL for this script's own reads. A rehearsal on
 * local forks also sets CELO_REHEARSAL_RELAY_URL (see mainnet-guard.ts).
 *
 * Run (from tests/e2e):
 *   bun run live:celo-fees
 *   bun run live:celo-fees -- --tokens usdc,usdt
 *   bun run live:celo-fees -- --send --i-am-doris
 */
import { createClient, signerFromPrivateKey, CELO, type NetworkConfig } from "@altananetwork/sdk";
import { createPublicClient, formatEther, formatUnits, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celoMainnetForScript, confirmMainnetSend, transactionLine } from "./mainnet-guard.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SEND = flag("--send");
const { network, rehearsal: REHEARSAL } = celoMainnetForScript<NetworkConfig>(CELO);
const NAME = network.chain.name;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** "USD₮" and "usdt" name the same currency on a command line; so do "USA₮" and "usat". */
const plain = (symbol: string) => symbol.toLowerCase().replace("₮", "t");

type Row = { symbol: string; outcome: string; transactionHash?: Hex };

async function main() {
  console.log(`@altananetwork/sdk live proof: fee in each currency on ${NAME} (chain ${network.chainId}), ${SEND ? "SENDING" : "dry run"}${REHEARSAL ? " (REHEARSAL on local forks, no real funds)" : ""}`);
  const pub = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });
  const client = createClient({ chains: [network] });

  console.log("\n[0] the fee currencies the relay offers");
  const listed = await client.feeCurrencies();
  for (const c of listed.currencies) {
    console.log(`    ${c.symbol.padEnd(6)} ${c.isNative ? "native token".padEnd(42) : c.address}  1 ${c.symbol} = ${formatEther(c.nativeRate)} CELO`);
  }
  const wanted = option("--tokens")?.split(",").map((s) => plain(s.trim())).filter(Boolean);
  const candidates = listed.currencies.filter((c) => !c.isNative && (!wanted || wanted.includes(plain(c.symbol))));
  if (wanted) {
    const unknown = wanted.filter((w) => !listed.currencies.some((c) => plain(c.symbol) === w));
    if (unknown.length) throw new Error(`The relay does not list ${unknown.join(", ")} on ${NAME}. It lists: ${listed.currencies.map((c) => c.symbol).join(", ")}.`);
  }

  console.log("\n[1] the wallet");
  const adminKey = process.env.MAINNET_TEST_CELO_KEY as Hex;
  if (!adminKey) throw new Error("Set MAINNET_TEST_CELO_KEY (set -a; source <ecosystem>/.env.mainnet; set +a).");
  const admin = signerFromPrivateKey(adminKey);
  const wallet = { address: privateKeyToAccount(adminKey).address };
  const code = await pub.getCode({ address: wallet.address });
  if (!code || code === "0x") throw new Error(`${wallet.address} is not set up on ${NAME} yet. Run live:celo-proof first.`);
  const balanceOf = (token: Address) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });
  console.log(`    ${wallet.address}, holding ${formatEther(await pub.getBalance({ address: wallet.address }))} CELO`);
  const held = new Map<string, bigint>();
  for (const c of candidates) {
    const balance = await balanceOf(c.address);
    held.set(c.symbol, balance);
    console.log(`    ${c.symbol.padEnd(6)} ${formatUnits(balance, c.decimals)}`);
  }

  console.log("\n[2] what one transaction costs in each currency");
  const call = { to: wallet.address, value: 0n };
  const payable: typeof candidates = [];
  const rows: Row[] = [];
  for (const c of candidates) {
    const balance = held.get(c.symbol)!;
    if (balance === 0n) {
      console.log(`    ${c.symbol.padEnd(6)} the wallet holds none: skipped`);
      rows.push({ symbol: c.symbol, outcome: "skipped, the wallet holds none" });
      continue;
    }
    try {
      const quote = await client.quoteExecute({ wallet, signer: admin, calls: call, feeToken: c.address });
      const inCelo = (quote.fee * c.nativeRate) / 10n ** BigInt(c.decimals);
      console.log(`    ${c.symbol.padEnd(6)} at most ${formatUnits(quote.fee, c.decimals)} ${c.symbol} (about ${formatEther(inCelo)} CELO)`);
      if (quote.feeToken.toLowerCase() !== c.address.toLowerCase()) throw new Error(`the relay quoted in ${quote.feeToken}, not in ${c.symbol}`);
      if (balance < quote.fee) {
        console.log(`           the wallet holds ${formatUnits(balance, c.decimals)}, less than that: skipped`);
        rows.push({ symbol: c.symbol, outcome: "skipped, the wallet holds less than the fee" });
        continue;
      }
      payable.push(c);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      console.log(`    ${c.symbol.padEnd(6)} no quote: ${why}`);
      rows.push({ symbol: c.symbol, outcome: `no quote: ${why}` });
    }
  }

  if (!SEND) {
    console.log(`\nDry run: nothing was signed or sent. With --send, one transaction would pay its fee in each of: ${payable.map((c) => c.symbol).join(", ") || "none"}.`);
    return;
  }
  if (payable.length === 0) throw new Error("The wallet cannot pay a fee in any listed currency. Nothing was sent.");
  await confirmMainnetSend({
    args,
    what: `real ${payable.map((c) => c.symbol).join(", ")} from ${wallet.address} on ${NAME}`,
    phrase: "spend real funds",
  });

  console.log("\n[3] one transaction per currency, fee paid in it");
  for (const c of payable) {
    const before = await balanceOf(c.address);
    const result = await client.execute({ wallet, signer: admin, calls: call, feeToken: c.address });
    if (result.status !== "CONFIRMED") throw new Error(`${c.symbol}: the transaction ended as ${result.status}`);
    const after = await balanceOf(c.address);
    const paid = before - after;
    if (paid <= 0n) throw new Error(`${c.symbol}: the wallet's ${c.symbol} balance did not drop, so the fee was not paid in it`);
    if (result.feeToken && result.feeToken.toLowerCase() !== c.address.toLowerCase()) {
      throw new Error(`${c.symbol}: the relay reports the fee token as ${result.feeToken}`);
    }
    console.log(`    ${c.symbol.padEnd(6)} paid ${formatUnits(paid, c.decimals)} ${c.symbol}  ${transactionLine(network.explorer, result.transactionHash, REHEARSAL)}`);
    rows.push({ symbol: c.symbol, outcome: `fee paid: ${formatUnits(paid, c.decimals)} ${c.symbol}`, transactionHash: result.transactionHash as Hex });
  }

  console.log("\nResult");
  for (const r of rows) console.log(`    ${r.symbol.padEnd(6)} ${r.outcome}${r.transactionHash ? `  ${r.transactionHash}` : ""}`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
