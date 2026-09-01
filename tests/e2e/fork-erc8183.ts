/**
 * FORK E2E: the ERC-8183 buyer flow against the REAL testnet kernel bytecode.
 *
 * Forks BSC testnet (chain 97) — genuine AgenticCommerce / EvaluatorRouter /
 * OptimisticPolicy / $U deployments — and drives the full buyer lifecycle:
 *
 *   1. buildHireCalls: createJob → registerJob → setBudget → approve → fund
 *      (the exact five calls hireErc8183Agent batches through the relay),
 *      with the jobId predicted from jobCounter()+1.
 *   2. Assert the job is FUNDED, ours, and the $U escrow actually moved.
 *   3. Warp past expiredAt (seller never submits), claimRefund, assert the
 *      escrow came back and the job is EXPIRED.
 *
 * Run: bun run fork:erc8183   (from tests/e2e)
 */
import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  formatUnits,
  type Address,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildHireCalls, buildClaimRefundCall, erc8183Addresses, getErc8183Job, JOB_STATUS } from "@altananetwork/sdk";

const A = erc8183Addresses(97);
// `||`, not `??`: an unset GitHub Actions secret arrives as an empty string,
// which would be handed to `anvil --fork-url` verbatim (same guard as
// fork-erc8004.ts — this exact line broke CI when the test joined fork:all).
const RPC = process.env.BSC_TESTNET_FORK_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const ANVIL_PORT = 8551;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const BUDGET = 2n * 10n ** 18n; // 2 $U

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const VIEW_ABI = [
  { name: "jobCounter", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "disputeWindow", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
] as const;

const test = createTestClient({ mode: "anvil", chain: bscTestnet, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(ANVIL_URL) });

const network = { chain: bscTestnet, chainId: 97, publicRpcUrl: ANVIL_URL } as never; // NetworkConfig for getErc8183Job

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try { await publicClient.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil not ready");
}
async function dealToken(token: Address, holder: Address, amount: bigint) {
  for (let slot = 0; slot < 60; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
    await test.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
    const bal = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [holder] });
    if (bal === amount) return;
    await test.setStorageAt({ address: token, index: key, value: pad("0x0") });
  }
  throw new Error("balances slot not found");
}
const u = (v: bigint) => `${formatUnits(v, 18)} $U`;

async function main() {
  console.log(`\n▶ Booting anvil BSC-testnet fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  try {
    await waitForAnvil();

    const buyer = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: buyer.address, value: 10n ** 20n });
    await dealToken(A.paymentToken, buyer.address, 10n * 10n ** 18n);
    const asBuyer = createWalletClient({ account: buyer, chain: bscTestnet, transport: http(ANVIL_URL) });

    const [jobCounter, disputeWindow, block] = await Promise.all([
      publicClient.readContract({ address: A.commerce, abi: VIEW_ABI, functionName: "jobCounter" }),
      publicClient.readContract({ address: A.policy, abi: VIEW_ABI, functionName: "disputeWindow" }),
      publicClient.getBlock(),
    ]);
    const jobId = jobCounter + 1n;
    const expiredAt = block.timestamp + BigInt(disputeWindow) + 1800n;
    console.log(`  jobCounter=${jobCounter} → predicting jobId=${jobId}; disputeWindow=${disputeWindow}s`);

    // ── The five buyer calls (what hireErc8183Agent batches via the relay). ──
    console.log(`▶ createJob → registerJob → setBudget → approve → fund (budget ${u(BUDGET)}) ...`);
    const calls = buildHireCalls({
      addresses: A,
      jobId,
      provider: privateKeyToAccount(generatePrivateKey()).address,
      description: "Audit wallet 0x0000000000000000000000000000000000000001's Venus position (fork test)",
      budget: BUDGET,
      expiredAt,
    });
    const buyerBefore = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [buyer.address] });
    for (const call of calls) {
      const h = await asBuyer.sendTransaction({ to: call.to, data: call.data });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
      assert(rcpt.status === "success", `call to ${call.to} (${call.data!.slice(0, 10)}) reverted`);
    }

    const job = await getErc8183Job(network, jobId);
    const buyerAfter = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [buyer.address] });
    assert(job.client.toLowerCase() === buyer.address.toLowerCase(), "job.client is the buyer");
    assert(job.statusName === "FUNDED", `job is FUNDED (got ${job.statusName})`);
    assert(job.budget === BUDGET, "budget matches");
    assert(buyerBefore - buyerAfter === BUDGET, `escrow moved: buyer paid ${u(buyerBefore - buyerAfter)}`);
    console.log(`  ✓ job ${jobId} FUNDED on the real kernel; ${u(BUDGET)} escrowed`);

    // ── Seller never delivers → warp past expiredAt and reclaim. ──
    console.log("▶ Warping past expiredAt, claiming refund ...");
    await test.increaseTime({ seconds: Number(expiredAt - block.timestamp) + 60 });
    await test.mine({ blocks: 1 });
    const refund = buildClaimRefundCall(97, jobId);
    const h = await asBuyer.sendTransaction({ to: refund.to, data: refund.data });
    assert((await publicClient.waitForTransactionReceipt({ hash: h })).status === "success", "claimRefund reverted");

    const after = await getErc8183Job(network, jobId);
    const buyerFinal = await publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [buyer.address] });
    assert(after.statusName === "EXPIRED", `job is EXPIRED (got ${after.statusName})`);
    assert(buyerFinal === buyerBefore, `escrow refunded in full (${u(buyerFinal)})`);
    console.log(`  ✓ job EXPIRED, ${u(BUDGET)} refunded to the buyer`);
    console.log(`  (status enum sanity: ${JOB_STATUS.join(" → ")})`);

    console.log("\nResult: PASS ✓ — full ERC-8183 buyer lifecycle against real kernel bytecode.\n");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
