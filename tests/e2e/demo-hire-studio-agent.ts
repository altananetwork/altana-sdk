/**
 * DEMO: an Altana buyer hires an ERC-8183 seller agent end-to-end — job
 * funded, deliverable submitted and retrieved, escrow settled to the seller.
 *
 * Runs on an anvil BSC-testnet fork (real AgenticCommerce / EvaluatorRouter /
 * OptimisticPolicy / $U bytecode). The seller side is played by a
 * Studio-style provider: it detects the funded job, serves a
 * DeliverableManifest over HTTP, and submits on-chain with
 * `{"deliverable_url": …}` optParams — exactly what a bnbagent-studio seller
 * (e.g. the Venus Position Advisor) does.
 *
 *   1. BUYER  hireErc8183Agent-equivalent call batch → job FUNDED, 2 $U escrowed.
 *   2. SELLER serves the manifest and submits keccak256(canonicalManifest).
 *   3. BUYER  getErc8183DeliverableUrl → fetch manifest → read the report.
 *   4. Warp past the dispute window; settle → verdict APPROVE → seller paid.
 *
 * Run: bun run demo:hire-studio-agent   (from tests/e2e)
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
  type Hex,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  buildHireCalls,
  erc8183Addresses,
  getErc8183Job,
  getErc8183DeliverableUrl,
  buildSubmitCall,
  encodeErc8183Manifest,
  erc8183ManifestHash,
  verifyErc8183ManifestText,
  type Erc8183DeliverableManifest,
} from "@altananetwork/sdk";

const A = erc8183Addresses(97);
const RPC = process.env.BSC_TESTNET_FORK_RPC_URL ?? "https://data-seed-prebsc-1-s1.binance.org:8545";
const ANVIL_PORT = 8552;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const MANIFEST_PORT = 8793;
const BUDGET = 2n * 10n ** 18n; // 2 $U

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const VIEW_ABI = [
  { name: "jobCounter", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "disputeWindow", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
] as const;
const SETTLE_ABI = [
  { name: "settle", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "evidence", type: "bytes" }], outputs: [] },
] as const;

const test = createTestClient({ mode: "anvil", chain: bscTestnet, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(ANVIL_URL) });
const network = { chain: bscTestnet, chainId: 97, publicRpcUrl: ANVIL_URL } as never;

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
const balance = (a: Address) =>
  publicClient.readContract({ address: A.paymentToken, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });

async function main() {
  console.log(`\n▶ Booting anvil BSC-testnet fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  let manifestServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    await waitForAnvil();

    // ── Actors: Altana-side buyer, Studio-style seller. ──
    const buyer = privateKeyToAccount(generatePrivateKey());
    const seller = privateKeyToAccount(generatePrivateKey());
    for (const a of [buyer.address, seller.address]) await test.setBalance({ address: a, value: 10n ** 20n });
    await dealToken(A.paymentToken, buyer.address, 10n * 10n ** 18n);
    const asBuyer = createWalletClient({ account: buyer, chain: bscTestnet, transport: http(ANVIL_URL) });
    const asSeller = createWalletClient({ account: seller, chain: bscTestnet, transport: http(ANVIL_URL) });

    // ── 1. BUYER: hire the seller (the exact batch hireErc8183Agent sends). ──
    const [jobCounter, disputeWindow, block] = await Promise.all([
      publicClient.readContract({ address: A.commerce, abi: VIEW_ABI, functionName: "jobCounter" }),
      publicClient.readContract({ address: A.policy, abi: VIEW_ABI, functionName: "disputeWindow" }),
      publicClient.getBlock(),
    ]);
    const jobId = jobCounter + 1n;
    const task = "Audit wallet 0x1234…'s Venus position: health factor, risks, and the best next move.";
    console.log(`▶ BUYER hires seller for ${u(BUDGET)} (job ${jobId}): "${task.slice(0, 60)}…"`);
    const calls = buildHireCalls({
      addresses: A,
      jobId,
      provider: seller.address,
      description: task,
      budget: BUDGET,
      expiredAt: block.timestamp + BigInt(disputeWindow) + 1800n,
    });
    for (const call of calls) {
      const h = await asBuyer.sendTransaction({ to: call.to, data: call.data });
      assert((await publicClient.waitForTransactionReceipt({ hash: h })).status === "success", `buyer call reverted`);
    }
    assert((await getErc8183Job(network, jobId)).statusName === "FUNDED", "job FUNDED");
    console.log(`  ✓ job FUNDED — ${u(BUDGET)} escrowed on the kernel`);

    // ── 2. SELLER: serve the DeliverableManifest, submit on-chain. ──
    const report =
      "VERDICT: REPAY. Health factor 1.18 — repay 120 USDT to restore HF 1.62. " +
      "Best new position: supply BNB (net APY 4.1%), borrow headroom 30%.";
    const manifest: Erc8183DeliverableManifest = {
      version: 1,
      job_id: Number(jobId),
      chain_id: 97,
      contracts: { commerce: A.commerce, router: A.router, policy: A.policy },
      response: { content: report, content_type: "text/plain" },
      metadata: {},
    };
    const manifestUrl = `http://127.0.0.1:${MANIFEST_PORT}/manifest.json`;
    // Serve EXACTLY the canonical bytes that were hashed: buyers verify the
    // raw served text against the on-chain hash (SDK codec — Python-identical).
    const manifestText = encodeErc8183Manifest(manifest);
    manifestServer = Bun.serve({
      port: MANIFEST_PORT,
      fetch: () => new Response(manifestText, { headers: { "content-type": "application/json" } }),
    });
    const deliverableHash = erc8183ManifestHash(manifest);
    console.log("▶ SELLER submits the deliverable (manifest hash on-chain, URL in optParams) ...");
    const submitCall = buildSubmitCall({
      addresses: A,
      jobId,
      deliverable: deliverableHash,
      optParams: toHex(JSON.stringify({ deliverable_url: manifestUrl })),
    });
    const submitTx = await asSeller.sendTransaction({ to: submitCall.to, data: submitCall.data });
    assert((await publicClient.waitForTransactionReceipt({ hash: submitTx })).status === "success", "submit reverted");
    assert((await getErc8183Job(network, jobId)).statusName === "SUBMITTED", "job SUBMITTED");
    console.log("  ✓ job SUBMITTED");

    // ── 3. BUYER: resolve + fetch + verify the deliverable. ──
    console.log("▶ BUYER retrieves the deliverable ...");
    // Keep the getLogs scan inside the fork's LOCAL blocks: any range touching
    // pre-fork blocks is forwarded to the upstream testnet RPC, which
    // throttles eth_getLogs (-32005). 9 local blocks precede head here
    // (5 buyer txs + submit + 3 mined), so an 8-block window stays local.
    await test.mine({ blocks: 3 });
    const url = await getErc8183DeliverableUrl(network, jobId, { scanWindow: 8n, maxWindows: 1 });
    assert(url === manifestUrl, `deliverable URL resolved from JobInitialised (got ${url})`);
    const fetched = await (await fetch(url!)).text();
    assert(verifyErc8183ManifestText(fetched, deliverableHash), "manifest integrity: raw text verifies against on-chain deliverable");
    const content = JSON.parse(fetched).response.content as string;
    assert(content.includes("VERDICT"), "report content retrieved");
    console.log(`  ✓ report: "${content.slice(0, 72)}…" (integrity verified)`);

    // ── 4. Dispute window passes silently → settle pays the seller. ──
    console.log("▶ Warping past the dispute window, settling ...");
    await test.increaseTime({ seconds: Number(disputeWindow) + 60 });
    await test.mine({ blocks: 1 });
    const sellerBefore = await balance(seller.address);
    const settleTx = await asBuyer.sendTransaction({
      to: A.router,
      data: encodeFunctionData({ abi: SETTLE_ABI, functionName: "settle", args: [jobId, "0x"] }),
    });
    assert((await publicClient.waitForTransactionReceipt({ hash: settleTx })).status === "success", "settle reverted");
    const sellerAfter = await balance(seller.address);
    const job = await getErc8183Job(network, jobId);
    assert(job.statusName === "COMPLETED", `job COMPLETED (got ${job.statusName})`);
    assert(sellerAfter > sellerBefore, "seller received the escrow");
    console.log(`  ✓ job COMPLETED — seller received ${u(sellerAfter - sellerBefore)} (escrow minus platform fee)`);

    console.log("\nResult: PASS ✓ — hire → deliver → retrieve → settle, on real kernel bytecode.\n");
  } finally {
    manifestServer?.stop(true);
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
