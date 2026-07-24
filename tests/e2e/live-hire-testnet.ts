/**
 * LIVE (BSC testnet, real relay, real third-party seller):
 *
 *   1. Create a fresh Altana wallet; fund tBNB via the testnet relay faucet.
 *   2. Claim 10 $U from the public $U faucet (requestTokens) THROUGH the relay.
 *   3. Hire a live ERC-8183 seller discovered on the kernel (Mode A: plain
 *      task) with hireErc8183Agent — five calls, ONE atomic relay intent.
 *   4. Print the job id + state; a later run of erc8183_job_status (or
 *      `bun run live-hire-testnet.ts status <jobId>`) checks for delivery.
 *      If the seller ignores us, claimRefund after expiry returns the escrow.
 *
 * State (wallet key, jobId) persists to .live-hire-state.json (untracked).
 * Run: bun run live-hire-testnet.ts [status <jobId> | refund <jobId>]
 */
import { encodeFunctionData, formatEther, formatUnits, parseEther, type Address, type Hex } from "viem";
import {
  createClient,
  signerFromPrivateKey,
  hireErc8183Agent,
  buildClaimRefundCall,
  getErc8183Job,
  getErc8183DeliverableUrl,
  fundNative,
  waitForBalance,
  erc8183Addresses,
  BNB_TESTNET,
} from "@altananetwork/sdk";
import { buildPublicClient, buildRelayClient } from "../../packages/wallet/src/internal/relay.js";

const STATE_FILE = new URL("./.live-hire-state.json", import.meta.url).pathname;
const U_FAUCET: Address = "0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3";
const SELLER: Address = "0x6126f0486D0f1ab91c2adC56Ad9584483f1Ca091"; // most active live provider
const BUDGET = 100_000_000_000_000_000n; // 0.1 $U (the seller's typical job size)
const A = erc8183Addresses(97);

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const FAUCET_ABI = [
  { name: "requestTokens", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

const publicClient = buildPublicClient(BNB_TESTNET);
const u = (v: bigint) => `${formatUnits(v, 18)} $U`;

async function status(jobId: bigint) {
  const job = await getErc8183Job(BNB_TESTNET, jobId);
  console.log(`job ${jobId}: ${job.statusName}`);
  console.log(`  provider: ${job.provider}  budget: ${u(job.budget)}  expiredAt: ${new Date(Number(job.expiredAt) * 1000).toISOString()}`);
  if (job.submittedAt > 0n) {
    const url = await getErc8183DeliverableUrl(BNB_TESTNET, jobId);
    console.log(`  deliverable: ${url}`);
    if (url?.startsWith("http")) {
      const manifest: any = await (await fetch(url)).json();
      console.log(`  content: ${JSON.stringify(manifest?.response?.content)?.slice(0, 500)}`);
    }
  }
}

/** Reclaim the escrow of an expired, undelivered job back to the wallet. */
async function refund(jobId: bigint) {
  const state = JSON.parse(await Bun.file(STATE_FILE).text());
  const client = createClient({ chains: [BNB_TESTNET] });
  const admin = signerFromPrivateKey(state.adminPrivateKey);
  const wallet = await client.createWallet({ signer: admin });
  if (wallet.address !== state.walletAddress) throw new Error("persisted key does not match wallet address");

  const job = await getErc8183Job(BNB_TESTNET, jobId);
  console.log(`job ${jobId}: ${job.statusName}, budget ${u(job.budget)}, expired ${new Date(Number(job.expiredAt) * 1000).toISOString()}`);
  const before = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });

  console.log(`claiming refund via relay ...`);
  const res = await client.execute({
    wallet,
    signer: admin,
    calls: [buildClaimRefundCall(97, jobId)],
    chainId: 97,
  });
  console.log(`  execute status: ${res.status} tx ${res.transactionHash}`);

  const after = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });
  console.log(`  $U balance: ${u(before)} → ${u(after)}`);
  console.log(`  job now: ${(await getErc8183Job(BNB_TESTNET, jobId)).statusName}`);
}

async function main() {
  const [, , cmd, arg] = process.argv;
  if (cmd === "status") return status(BigInt(arg!));
  if (cmd === "refund") return refund(BigInt(arg!));

  console.log("LIVE hire on BSC testnet — real relay, real seller");
  console.log("==================================================\n");

  // 1. Load the persisted wallet (key saved BEFORE funding; the relay
  // faucet is currently a no-op on testnet-relay, so tBNB arrives manually).
  const state = JSON.parse(await Bun.file(STATE_FILE).text());
  const client = createClient({ chains: [BNB_TESTNET] });
  const admin = signerFromPrivateKey(state.adminPrivateKey);
  const wallet = await client.createWallet({ signer: admin });
  if (wallet.address !== state.walletAddress) throw new Error("persisted key does not match wallet address");
  console.log(`[1] wallet ${wallet.address} (persisted)`);
  await waitForBalance(publicClient, wallet.address, parseEther("0.005"), 300_000);
  console.log(`    balance: ${formatEther(await publicClient.getBalance({ address: wallet.address }))} tBNB`);

  // 2. Claim $U through the relay (msg.sender = the smart account).
  console.log("[2] claiming 10 $U from the public faucet via relay ...");
  const claim = await client.execute({
    wallet,
    signer: admin,
    calls: [{ to: U_FAUCET, data: encodeFunctionData({ abi: FAUCET_ABI, functionName: "requestTokens" }) }],
    chainId: 97,
  });
  console.log(`    execute status: ${claim.status} tx ${claim.transactionHash}`);
  const uBal = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });
  console.log(`    $U balance: ${u(uBal)}`);
  if (uBal < BUDGET) throw new Error("faucet claim did not land");

  // 3. Hire the live seller — one atomic relay intent.
  const task =
    "Summarize the current state of the Venus protocol markets on BSC in 3 bullet points. " +
    "Plain text answer. (Paid via ERC-8183 escrow from an Altana smart-account wallet.)";
  console.log(`[3] hiring live seller ${SELLER} for ${u(BUDGET)} ...`);
  const result = await hireErc8183Agent(
    wallet,
    admin,
    { provider: SELLER, task, budget: BUDGET },
    { network: BNB_TESTNET },
  );
  console.log(`    ✓ job ${result.jobId} — intent status ${result.status} tx ${result.transactionHash}`);
  const job = await getErc8183Job(BNB_TESTNET, result.jobId);
  console.log(`    on-chain: ${job.statusName}, budget ${u(job.budget)}, client ${job.client}`);

  await Bun.write(
    STATE_FILE,
    JSON.stringify(
      {
        ...state,
        jobId: result.jobId.toString(),
        seller: SELLER,
        budget: BUDGET.toString(),
        expiredAt: result.expiredAt.toString(),
        hiredAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nstate saved → ${STATE_FILE}`);
  console.log(`check later:  bun run live-hire-testnet.ts status ${result.jobId}`);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
