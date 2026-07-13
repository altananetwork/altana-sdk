/**
 * END-TO-END DEMO: an agent developer using the Altana wallet pays a B402
 * (x402) service for a premium API resource — no code changes to their fetch.
 *
 * What runs here, all locally against an anvil BNB fork (no real funds):
 *   1. A provisioned Altana smart wallet with a scoped SESSION key (the agent's
 *      key), USDT balance, Permit2 approved, and Permit2 approved as the
 *      signature checker.
 *   2. A mock B402 service (HTTP): GET /premium returns 402 + payment
 *      requirements; when it sees a valid X-PAYMENT it acts as the FACILITATOR,
 *      settles on-chain via the REAL Permit2, then returns the premium content.
 *   3. The AGENT: one call — `fetchWithX402(session, url)` — which transparently
 *      pays the 402 and returns the resource.
 *
 * Run: bun tests/e2e/demo-b402.ts
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
  concatHex,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPrivateKeySigner, fetchWithX402 } from "@altananetwork/sdk";
import type { Session } from "@altananetwork/sdk";

const ITHACA_ACCOUNT_IMPL: Address =
  "0x4B5d20CD8a3927B500540d9BcCDDc27385c9fA79";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
const BSC_RPC = "https://bsc-rpc.publicnode.com";
const ANVIL_PORT = 8548;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const HTTP_PORT = 8788;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ACCOUNT_ABI = [
  { name: "authorize", type: "function", stateMutability: "nonpayable", inputs: [{ name: "key", type: "tuple", components: [{ name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" }, { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" }] }], outputs: [{ name: "keyHash", type: "bytes32" }] },
  { name: "setSignatureCheckerApproval", type: "function", stateMutability: "nonpayable", inputs: [{ name: "keyHash", type: "bytes32" }, { name: "checker", type: "address" }, { name: "isApproved", type: "bool" }], outputs: [] },
] as const;

const PERMIT2_ABI = [
  { name: "permitTransferFrom", type: "function", stateMutability: "nonpayable", inputs: [
    { name: "permit", type: "tuple", components: [{ name: "permitted", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { name: "transferDetails", type: "tuple", components: [{ name: "to", type: "address" }, { name: "requestedAmount", type: "uint256" }] },
    { name: "owner", type: "address" },
    { name: "signature", type: "bytes" },
  ], outputs: [] },
] as const;

const test = createTestClient({ mode: "anvil", chain: bsc, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bsc, transport: http(ANVIL_URL) });

function log(msg: string) {
  console.log(msg);
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function waitForAnvil() {
  const probe = createPublicClient({ transport: http(ANVIL_URL) });
  for (let i = 0; i < 60; i++) {
    try { await probe.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil not ready");
}
async function dealToken(token: Address, holder: Address, amount: bigint) {
  for (let slot = 0; slot < 30; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
    await test.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
    const bal = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [holder] });
    if (bal === amount) return;
    await test.setStorageAt({ address: token, index: key, value: pad("0x0") });
  }
  throw new Error("balances slot not found");
}
const usdt = (v: bigint) => `${formatUnits(v, 18)} USDT`;

async function main() {
  log(`\n▶ Booting anvil BNB fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", BSC_RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await waitForAnvil();

    // ── The merchant (B402 service) and its facilitator settler EOA. ──
    const facilitator = privateKeyToAccount(generatePrivateKey());
    const merchant: Address = privateKeyToAccount(generatePrivateKey()).address;
    await test.setBalance({ address: facilitator.address, value: 10n ** 20n });
    const facilitatorClient = createWalletClient({ account: facilitator, chain: bsc, transport: http(ANVIL_URL) });
    const price = 500_000_000_000_000_000n; // 0.5 USDT

    // ── Provision the agent's Altana wallet (normally done once via the SDK/
    //    relay; here we set the on-chain state directly on the fork). ──
    log("▶ Provisioning the agent's Altana wallet (session key + Permit2) ...");
    const walletSigner = createPrivateKeySigner();
    const wallet = walletSigner.address;
    await test.setBalance({ address: wallet, value: 10n ** 20n });
    await test.setCode({ address: wallet, bytecode: concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]) });
    await dealToken(USDT, wallet, 10n * 10n ** 18n); // 10 USDT

    const sessionSigner = createPrivateKeySigner(); // the AGENT's scoped key
    const session: Session = { walletAddress: wallet, signer: sessionSigner, publicKey: sessionSigner.publicKey, permissions: {}, expiry: 0 };
    const sessionPub = encodeAbiParameters([{ type: "address" }], [sessionSigner.address]);
    const keyHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, keccak256(sessionPub)]));

    await test.impersonateAccount({ address: wallet });
    const asWallet = createWalletClient({ account: wallet, chain: bsc, transport: http(ANVIL_URL) });
    for (const s of [
      { to: USDT, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, 2n ** 256n - 1n] }) },
      { to: wallet, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "authorize", args: [{ expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: sessionPub }] }) },
      { to: wallet, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setSignatureCheckerApproval", args: [keyHash, PERMIT2, true] }) },
    ]) {
      const h = await asWallet.sendTransaction(s);
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    await test.stopImpersonatingAccount({ address: wallet });
    log(`  wallet ${wallet} funded with ${usdt(10n * 10n ** 18n)}, session key authorized.`);

    // ── The B402 service: 402 challenge, then facilitator settlement. ──
    log("▶ Starting mock B402 service on :" + HTTP_PORT + " (price 0.5 USDT) ...");
    server = Bun.serve({
      port: HTTP_PORT,
      async fetch(req) {
        const xPayment = req.headers.get("X-PAYMENT");
        if (!xPayment) {
          return new Response(
            JSON.stringify({
              x402Version: 1,
              error: "payment required",
              accepts: [
                {
                  scheme: "permit2",
                  network: "bsc",
                  asset: USDT,
                  maxAmountRequired: price.toString(),
                  payTo: merchant,
                  maxTimeoutSeconds: 600,
                  extra: { spender: facilitator.address },
                },
              ],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }
        // Facilitator: decode the payment and settle via REAL Permit2.
        const decoded = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8"));
        const p = decoded.payload;
        try {
          const h = await facilitatorClient.sendTransaction({
            to: PERMIT2,
            data: encodeFunctionData({
              abi: PERMIT2_ABI,
              functionName: "permitTransferFrom",
              args: [
                { permitted: { token: p.permit.permitted.token, amount: BigInt(p.permit.permitted.amount) }, nonce: BigInt(p.permit.nonce), deadline: BigInt(p.permit.deadline) },
                { to: merchant, requestedAmount: BigInt(p.permit.permitted.amount) },
                p.from,
                p.signature,
              ],
            }),
          });
          const rcpt = await publicClient.waitForTransactionReceipt({ hash: h });
          if (rcpt.status !== "success") throw new Error("settlement reverted");
        } catch (e) {
          return new Response(JSON.stringify({ error: `settlement failed: ${e}` }), { status: 402 });
        }
        return new Response(
          JSON.stringify({ data: "🔮 premium oracle: BTC=$102,431 — sentiment bullish" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    // ── The AGENT developer's code. This is the entire integration. ──
    log("\n──────── AGENT CODE ────────");
    log('  const res = await fetchWithX402(session, "http://localhost:8788/premium");');
    const merchantBefore = await publicClient.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [merchant] });

    const res = await fetchWithX402(session, `http://localhost:${HTTP_PORT}/premium`);
    const bodyText = await res.text();
    log(`  → HTTP ${res.status}`);
    log(`  → body: ${bodyText}`);
    log("────────────────────────────\n");

    // ── Verify the money actually moved on-chain. ──
    const merchantAfter = await publicClient.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [merchant] });
    const walletAfter = await publicClient.readContract({ address: USDT, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });

    assert(res.status === 200, "agent received a 200 with the premium resource");
    assert(JSON.parse(bodyText).data.includes("premium"), "agent got the paid content");
    assert(merchantAfter - merchantBefore === price, `merchant received ${usdt(price)} (got ${usdt(merchantAfter - merchantBefore)})`);

    log(`✓ Merchant received ${usdt(merchantAfter - merchantBefore)} on-chain (real Permit2 settlement).`);
    log(`✓ Agent wallet balance now ${usdt(walletAfter)}.`);
    log("\nResult: PASS ✓  — agent paid a B402 service end-to-end with one fetch.\n");
  } finally {
    server?.stop(true);
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
