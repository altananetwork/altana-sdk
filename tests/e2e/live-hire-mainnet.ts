/**
 * LIVE (BSC MAINNET, real money — user-funded and user-approved):
 *
 *   1. Load Doris's persisted wallet (same key/address as testnet).
 *   2. Swap a sliver of BNB → $U on PancakeSwap v2 through the relay
 *      (first mainnet intent; KeyStore admin registration rides along).
 *   3. Hire a live mainnet ERC-8183 seller for 0.001 $U (one atomic intent).
 *
 * Run: bun run live-hire-mainnet.ts [status <jobId>]
 */
import { encodeFunctionData, formatEther, formatUnits, parseEther, type Address } from "viem";
import {
  createClient,
  signerFromPrivateKey,
  hireErc8183Agent,
  getErc8183Job,
  getErc8183DeliverableUrl,
  erc8183Addresses,
  BNB,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";

const KEY_FILE = new URL("./.live-hire-state.json", import.meta.url).pathname;
const STATE_FILE = new URL("./.live-hire-mainnet.json", import.meta.url).pathname;
const ROUTER: Address = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // Pancake v2
const WBNB: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const SELLER: Address = "0xC97cEc6bD1934Ba507F4786047c9bC269639C950"; // most active live mainnet provider
const SWAP_BNB = parseEther("0.0008");
const BUDGET = 1_000_000_000_000_000n; // 0.001 $U (~10x typical mainnet job)
const A = erc8183Addresses(56);

const ROUTER_ABI = [
  { name: "getAmountsOut", type: "function", stateMutability: "view", inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }], outputs: [{ type: "uint256[]" }] },
  { name: "swapExactETHForTokens", type: "function", stateMutability: "payable", inputs: [{ name: "amountOutMin", type: "uint256" }, { name: "path", type: "address[]" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }], outputs: [{ type: "uint256[]" }] },
] as const;
const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const publicClient = buildPublicClient(BNB);
const u = (v: bigint) => `${formatUnits(v, 18)} $U`;

async function status(jobId: bigint) {
  const job = await getErc8183Job(BNB, jobId);
  console.log(`job ${jobId}: ${job.statusName}  budget ${u(job.budget)}  expiredAt ${new Date(Number(job.expiredAt) * 1000).toISOString()}`);
  if (job.submittedAt > 0n) {
    const url = await getErc8183DeliverableUrl(BNB, jobId);
    console.log(`  deliverable: ${url}`);
    if (url?.startsWith("http")) {
      const manifest: any = await (await fetch(url)).json();
      console.log(`  content: ${JSON.stringify(manifest?.response?.content)?.slice(0, 600)}`);
    }
  }
}

async function main() {
  const [, , cmd, arg] = process.argv;
  if (cmd === "status") return status(BigInt(arg!));

  console.log("LIVE hire on BSC MAINNET — real relay, real seller, real money");
  console.log("===============================================================\n");

  const keyState = JSON.parse(await Bun.file(KEY_FILE).text());
  const client = createClient({ chains: [BNB] });
  const admin = signerFromPrivateKey(keyState.adminPrivateKey);
  const wallet = await client.createWallet({ signer: admin });
  if (wallet.address !== keyState.walletAddress) throw new Error("key/address mismatch");
  console.log(`[1] wallet ${wallet.address} — ${formatEther(await publicClient.getBalance({ address: wallet.address }))} BNB`);

  // 2. Swap BNB → $U (KeyStore registration prepends automatically).
  const amounts = await publicClient.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: "getAmountsOut", args: [SWAP_BNB, [WBNB, A.paymentToken]] });
  const minOut = (amounts[1]! * 98n) / 100n;
  console.log(`[2] swapping ${formatEther(SWAP_BNB)} BNB → ≥${u(minOut)} via PancakeSwap ...`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const swap = await client.execute({
    wallet,
    signer: admin,
    calls: [{
      to: ROUTER,
      value: SWAP_BNB,
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactETHForTokens", args: [minOut, [WBNB, A.paymentToken], wallet.address, deadline] }),
    }],
    chainId: 56,
  });
  console.log(`    status ${swap.status} tx ${swap.transactionHash}`);
  const uBal = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });
  console.log(`    $U balance: ${u(uBal)}`);
  if (uBal < BUDGET) throw new Error("swap did not land");

  // 3. Hire the live seller (respect relay nonce settling — brief pause).
  await new Promise((r) => setTimeout(r, 8000));
  const task =
    "Reply with a one-paragraph summary of what your agent service does and its typical price. " +
    "Plain text. (Test purchase from an Altana smart-account wallet via ERC-8183.)";
  console.log(`[3] hiring mainnet seller ${SELLER} for ${u(BUDGET)} ...`);
  const result = await hireErc8183Agent(wallet, admin, { provider: SELLER, task, budget: BUDGET }, { network: BNB });
  console.log(`    ✓ job ${result.jobId} — ${result.status} tx ${result.transactionHash}`);
  const job = await getErc8183Job(BNB, result.jobId);
  console.log(`    on-chain: ${job.statusName}, budget ${u(job.budget)}, client ${job.client}`);

  await Bun.write(STATE_FILE, JSON.stringify({
    network: "bsc-mainnet",
    walletAddress: wallet.address,
    jobId: result.jobId.toString(),
    seller: SELLER,
    budget: BUDGET.toString(),
    expiredAt: result.expiredAt.toString(),
    hiredAt: new Date().toISOString(),
  }, null, 2));
  console.log(`\nstate → ${STATE_FILE}`);
  console.log(`check: bun run live-hire-mainnet.ts status ${result.jobId}`);
}

main().catch((e) => {
  console.error("FAIL:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
