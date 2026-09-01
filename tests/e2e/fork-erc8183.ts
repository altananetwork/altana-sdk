/**
 * FORK E2E: the FULL ERC-8183 lifecycle — buyer AND seller — against the
 * REAL testnet kernel bytecode.
 *
 * Forks BSC testnet (chain 97) — genuine AgenticCommerce / EvaluatorRouter /
 * OptimisticPolicy / $U deployments — and drives both halves of the protocol
 * with the SDK's builders and codecs (issue #59 added the seller half):
 *
 *   Job A (happy path): buildHireCalls funds the job; the seller builds a
 *   deliverable manifest with the SDK codec (canonical JSON, Python-byte-
 *   identical incl. non-ASCII escaping), submits via buildSubmitCall,
 *   the on-chain hash matches erc8183ManifestHash, the buyer recovers the
 *   deliverable URL with getErc8183DeliverableUrl and verifies the raw text
 *   with verifyErc8183ManifestText, and after the dispute window the buyer
 *   settles — job COMPLETED, seller paid.
 *
 *   Job B (refund path): seller never submits; warp past expiredAt,
 *   claimRefund, job EXPIRED, escrow returned in full.
 *
 * Run: bun run fork:erc8183   (from tests/e2e)
 */
import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  formatUnits,
  type Address,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  buildHireCalls,
  buildClaimRefundCall,
  buildSubmitCall,
  encodeErc8183Manifest,
  erc8183Addresses,
  erc8183ManifestHash,
  getErc8183DeliverableUrl,
  getErc8183Job,
  verifyErc8183ManifestText,
  JOB_STATUS,
  type Erc8183DeliverableManifest,
} from "@altananetwork/sdk";

const A = erc8183Addresses(97);
const RPC = process.env.BSC_TESTNET_FORK_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545";
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
const ROUTER_SETTLE_ABI = [
  { name: "settle", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "evidence", type: "bytes" }], outputs: [] },
] as const;

const test = createTestClient({ mode: "anvil", chain: bscTestnet, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(ANVIL_URL) });

const network = { chain: bscTestnet, chainId: 97, publicRpcUrl: ANVIL_URL } as never; // NetworkConfig for the SDK reads

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
const uBal = (a: Address) =>
  publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });

async function hireJob(asBuyer: ReturnType<typeof createWalletClient>, buyer: Address, provider: Address) {
  const [jobCounter, disputeWindow, block] = await Promise.all([
    publicClient.readContract({ address: A.commerce, abi: VIEW_ABI, functionName: "jobCounter" }),
    publicClient.readContract({ address: A.policy, abi: VIEW_ABI, functionName: "disputeWindow" }),
    publicClient.getBlock(),
  ]);
  const jobId = jobCounter + 1n;
  const expiredAt = block.timestamp + BigInt(disputeWindow) + 1800n;
  const calls = buildHireCalls({
    addresses: A,
    jobId,
    provider,
    description: "Audit wallet 0x0000000000000000000000000000000000000001's Venus position (fork test)",
    budget: BUDGET,
    expiredAt,
  });
  for (const call of calls) {
    const h = await asBuyer.sendTransaction({ to: call.to, data: call.data, account: asBuyer.account!, chain: bscTestnet });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
    assert(rcpt.status === "success", `call to ${call.to} (${call.data!.slice(0, 10)}) reverted`);
  }
  const job = await getErc8183Job(network, jobId);
  assert(job.client.toLowerCase() === buyer.toLowerCase(), "job.client is the buyer");
  assert(job.statusName === "FUNDED", `job is FUNDED (got ${job.statusName})`);
  return { jobId, expiredAt, disputeWindow, fundedAtTs: block.timestamp };
}

async function main() {
  console.log(`\n▶ Booting anvil BSC-testnet fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  try {
    await waitForAnvil();

    const buyer = privateKeyToAccount(generatePrivateKey());
    const seller = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: buyer.address, value: 10n ** 20n });
    await test.setBalance({ address: seller.address, value: 10n ** 20n });
    await dealToken(A.paymentToken, buyer.address, 10n * 10n ** 18n);
    const asBuyer = createWalletClient({ account: buyer, chain: bscTestnet, transport: http(ANVIL_URL) });
    const asSeller = createWalletClient({ account: seller, chain: bscTestnet, transport: http(ANVIL_URL) });
    const buyerStart = await uBal(buyer.address);

    // ════════ Job A: the full happy path, buyer AND seller ════════
    console.log("▶ Job A: hire (createJob → registerJob → setBudget → approve → fund) ...");
    const a = await hireJob(asBuyer, buyer.address, seller.address);
    console.log(`  ✓ job ${a.jobId} FUNDED; ${u(BUDGET)} escrowed`);

    console.log("▶ Job A: seller builds the manifest with the SDK codec and submits ...");
    const manifest: Erc8183DeliverableManifest = {
      version: 1,
      job_id: Number(a.jobId),
      chain_id: 97,
      contracts: { commerce: A.commerce, router: A.router, policy: A.policy },
      // Non-ASCII on purpose — the canonical form must hash the same as the
      // Python reference (issue #59's cross-language trap).
      response: { content: "Position healthy — no action needed. Café ☕", content_type: "text/plain" },
      metadata: {},
    };
    const manifestText = encodeErc8183Manifest(manifest);
    const deliverable = erc8183ManifestHash(manifest);
    const deliverableUrl = "https://seller.example/manifests/fork-test.json";
    const submit = buildSubmitCall({
      addresses: A,
      jobId: a.jobId,
      deliverable,
      optParams: toHex(JSON.stringify({ deliverable_url: deliverableUrl })),
    });
    const sh = await asSeller.sendTransaction({ to: submit.to, data: submit.data, account: seller, chain: bscTestnet });
    assert((await publicClient.waitForTransactionReceipt({ hash: sh })).status === "success", "submit reverted");

    const submitted = await getErc8183Job(network, a.jobId);
    assert(submitted.statusName === "SUBMITTED", `job is SUBMITTED (got ${submitted.statusName})`);
    assert(submitted.deliverable.toLowerCase() === deliverable.toLowerCase(), "on-chain deliverable == erc8183ManifestHash(manifest)");
    assert(verifyErc8183ManifestText(manifestText, submitted.deliverable), "raw canonical text verifies against the on-chain hash");
    console.log(`  ✓ SUBMITTED; on-chain hash matches the SDK's canonical manifest hash`);

    // Buyer recovers the deliverable URL from the policy's JobInitialised log.
    await test.mine({ blocks: 3 }); // keep the scan window inside locally-mined blocks (upstream getLogs throttles)
    const url = await getErc8183DeliverableUrl(network, a.jobId, { scanWindow: 8n, maxWindows: 1 });
    assert(url === deliverableUrl, `deliverable URL round-trips (got ${url})`);
    console.log(`  ✓ buyer recovered deliverable_url via getErc8183DeliverableUrl`);

    console.log("▶ Job A: warp past the dispute window, buyer settles ...");
    await test.increaseTime({ seconds: Number(a.disputeWindow) + 60 });
    await test.mine({ blocks: 1 });
    const settleTx = await asBuyer.sendTransaction({
      to: A.router,
      data: encodeFunctionData({ abi: ROUTER_SETTLE_ABI, functionName: "settle", args: [a.jobId, "0x"] }),
      account: buyer,
      chain: bscTestnet,
    });
    assert((await publicClient.waitForTransactionReceipt({ hash: settleTx })).status === "success", "settle reverted");
    const settled = await getErc8183Job(network, a.jobId);
    const sellerPaid = await uBal(seller.address);
    assert(settled.statusName === "COMPLETED", `job is COMPLETED (got ${settled.statusName})`);
    assert(sellerPaid === BUDGET, `seller received the escrow (${u(sellerPaid)})`);
    console.log(`  ✓ COMPLETED; seller earned ${u(sellerPaid)} — the full economic loop, SDK both sides`);

    // ════════ Job B: seller never delivers → refund path ════════
    console.log("▶ Job B: hire, then warp past expiredAt and claim the refund ...");
    const b = await hireJob(asBuyer, buyer.address, privateKeyToAccount(generatePrivateKey()).address);
    const blockNow = await publicClient.getBlock();
    await test.increaseTime({ seconds: Number(b.expiredAt - blockNow.timestamp) + 60 });
    await test.mine({ blocks: 1 });
    const refund = buildClaimRefundCall(97, b.jobId);
    const rh = await asBuyer.sendTransaction({ to: refund.to, data: refund.data, account: buyer, chain: bscTestnet });
    assert((await publicClient.waitForTransactionReceipt({ hash: rh })).status === "success", "claimRefund reverted");

    const after = await getErc8183Job(network, b.jobId);
    const buyerFinal = await uBal(buyer.address);
    assert(after.statusName === "EXPIRED", `job is EXPIRED (got ${after.statusName})`);
    assert(buyerFinal === buyerStart - BUDGET, `only job A's escrow left the buyer (${u(buyerFinal)})`);
    console.log(`  ✓ job EXPIRED, ${u(BUDGET)} refunded to the buyer`);
    console.log(`  (status enum sanity: ${JOB_STATUS.join(" → ")})`);

    console.log("\nResult: PASS ✓ — full ERC-8183 lifecycle, buyer and seller, against real kernel bytecode.\n");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
