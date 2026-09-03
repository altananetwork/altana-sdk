/**
 * FORK E2E: @altananetwork/x402-server settles BOTH buyer families for real.
 *
 * Everything runs against an anvil BNB-mainnet fork (real $U, USDT and Permit2
 * bytecode; no real funds):
 *
 *   1. A merchant HTTP service charging 0.2 $U (eip3009) or 0.2 USDT
 *      (permit2-exact) per request via `createX402Merchant`.
 *   2. Buyer A — a BNB Agent Studio-style EOA: signs the EIP-3009
 *      `TransferWithAuthorization` on $U and sends the exact
 *      `bnbagent_studio_core` envelope (resource + accepted + backdated
 *      validAfter). The merchant settles via $U `transferWithAuthorization`.
 *   3. Buyer B — an Altana smart account with a scoped session key: pays via
 *      `fetchWithX402` (permit2-exact witness on USDT, ERC-1271 signature).
 *      The merchant settles via `Permit2.permitWitnessTransferFrom`.
 *   4. Replay of buyer A's header must be refused.
 *   5. Receipt read fails after the broadcast (#76): the merchant must answer
 *      200 with a pending receipt, never a fresh challenge, and the buyer's
 *      re-ask must not settle again. Exactly one transfer on chain.
 *
 * Run: bun run fork:x402-server   (from tests/e2e)
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
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createPrivateKeySigner,
  fetchWithX402,
  buildEip3009TypedData,
  PERMIT2_ADDRESS,
} from "@altananetwork/sdk";
import type { Session } from "@altananetwork/sdk";
import { createX402Merchant, U_TOKEN, USDT_BSC } from "@altananetwork/x402-server";

const ITHACA_ACCOUNT_IMPL: Address = "0x4B5d20CD8a3927B500540d9BcCDDc27385c9fA79";
const U = U_TOKEN[56];
const BSC_RPC = process.env.BSC_FORK_RPC_URL ?? "https://bsc-rpc.publicnode.com";
const ANVIL_PORT = 8549;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const HTTP_PORT = 8791;
const PROXY_PORT = 8792;
const PRICE = 200_000_000_000_000_000n; // 0.2 tokens (18 dec)

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ACCOUNT_ABI = [
  { name: "authorize", type: "function", stateMutability: "nonpayable", inputs: [{ name: "key", type: "tuple", components: [{ name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" }, { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" }] }], outputs: [{ name: "keyHash", type: "bytes32" }] },
  { name: "setSignatureCheckerApproval", type: "function", stateMutability: "nonpayable", inputs: [{ name: "keyHash", type: "bytes32" }, { name: "checker", type: "address" }, { name: "isApproved", type: "bool" }], outputs: [] },
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
  for (let slot = 0; slot < 60; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
    await test.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
    const bal = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [holder] });
    if (bal === amount) return;
    await test.setStorageAt({ address: token, index: key, value: pad("0x0") });
  }
  throw new Error(`balances slot not found for ${token}`);
}
const fmt = (v: bigint, sym: string) => `${formatUnits(v, 18)} ${sym}`;
const balanceOf = (token: Address, a: Address) =>
  publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });

async function main() {
  log(`\n▶ Booting anvil BNB fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", BSC_RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;

  try {
    await waitForAnvil();

    // ── The merchant: payout address + funded facilitator settler. ──
    const facilitator = privateKeyToAccount(generatePrivateKey());
    const merchantAddr: Address = privateKeyToAccount(generatePrivateKey()).address;
    await test.setBalance({ address: facilitator.address, value: 10n ** 20n });

    const merchant = createX402Merchant({
      chainId: 56,
      payTo: merchantAddr,
      price: PRICE,
      minPrice: PRICE / 4n,
      maxPrice: PRICE * 10n,
      rails: [
        { rail: "eip3009", token: U },
        { rail: "permit2-exact", token: USDT_BSC, spender: facilitator.address },
      ],
      maxTimeoutSeconds: 600,
      resource: `http://localhost:${HTTP_PORT}/audit`,
      facilitator,
      rpcUrl: ANVIL_URL,
      chain: bsc,
    });

    // A pass-through RPC in front of anvil whose only fault, when armed, is
    // failing `eth_getTransactionReceipt` with a JSON-RPC error: the "RPC
    // hiccup" of #76. Everything else (including eth_getTransactionByHash,
    // which viem's replacement check needs) goes straight through.
    let failReceipts = false;
    proxy = Bun.serve({
      port: PROXY_PORT,
      async fetch(req) {
        const body = await req.text();
        const rpc = JSON.parse(body || "{}");
        if (failReceipts && !Array.isArray(rpc) && rpc.method === "eth_getTransactionReceipt") {
          return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "receipt read unavailable" } });
        }
        const up = await fetch(ANVIL_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
        return new Response(await up.text(), { status: up.status, headers: { "content-type": "application/json" } });
      },
    });
    const flakyMerchant = createX402Merchant({
      chainId: 56,
      payTo: merchantAddr,
      price: PRICE,
      rails: [{ rail: "eip3009", token: U }],
      maxTimeoutSeconds: 600,
      resource: `http://localhost:${HTTP_PORT}/audit-flaky-rpc`,
      facilitator,
      rpcUrl: `http://127.0.0.1:${PROXY_PORT}`,
      chain: bsc,
      settleTimeoutMs: 15_000,
    });

    log("▶ Starting merchant service on :" + HTTP_PORT + " (0.2 $U / 0.2 USDT per call) ...");
    server = Bun.serve({
      port: HTTP_PORT,
      async fetch(req) {
        const m = new URL(req.url).pathname === "/audit-flaky-rpc" ? flakyMerchant : merchant;
        const { response, receipt } = await m.guard(req);
        if (response) return response;
        return new Response(
          JSON.stringify({ data: "🔮 paid capability output", settledTx: receipt!.txHash, settlement: receipt!.settlement }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    // ════ Buyer A: BNB Agent Studio-style EOA paying eip3009 $U. ════
    log("\n▶ Buyer A (Studio-style EOA, eip3009 $U) ...");
    const studioBuyer = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: studioBuyer.address, value: 10n ** 19n });
    await dealToken(U.address, studioBuyer.address, 10n * 10n ** 18n);

    // Fetch the challenge exactly like bnbagent_studio_core.x402.buyer does.
    const challengeRes = await fetch(`http://localhost:${HTTP_PORT}/audit`);
    assert(challengeRes.status === 402, "unpaid request gets a 402 challenge");
    const challenge: any = await challengeRes.json();
    const accepted = challenge.accepts.find(
      (a: any) => a.extra?.assetTransferMethod === "eip3009" && a.asset.toLowerCase() === U.address.toLowerCase(),
    );
    assert(!!accepted, "challenge offers an eip3009 $U option (payable by Studio)");

    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: studioBuyer.address,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter: String(now - 30), // studio backdates for clock skew
      validBefore: String(now + accepted.maxTimeoutSeconds),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signature = await studioBuyer.signTypedData(
      buildEip3009TypedData({
        chainId: 56,
        token: U.address,
        name: accepted.extra.name,
        version: accepted.extra.version,
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      }) as never,
    );
    // The exact studio envelope (build_x_payment_header).
    const studioHeader = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: challenge.resource,
        accepted,
        payload: { signature, authorization: auth },
      }),
    ).toString("base64");

    const merchantUBefore = await balanceOf(U.address, merchantAddr);
    const paidRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, { headers: { "X-PAYMENT": studioHeader } });
    const paidBody: any = await paidRes.json();
    const merchantUAfter = await balanceOf(U.address, merchantAddr);

    assert(paidRes.status === 200, `Studio buyer got 200 (got ${paidRes.status}: ${JSON.stringify(paidBody)})`);
    assert(merchantUAfter - merchantUBefore === PRICE, `merchant received ${fmt(PRICE, "$U")} (got ${fmt(merchantUAfter - merchantUBefore, "$U")})`);
    log(`  ✓ 200 + ${fmt(PRICE, "$U")} settled on-chain via transferWithAuthorization (tx ${paidBody.settledTx.slice(0, 14)}…)`);

    // Replay the same header — must be refused (on-chain nonce burnt).
    const replayRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, { headers: { "X-PAYMENT": studioHeader } });
    assert(replayRes.status === 402, "replayed authorization is refused");
    log("  ✓ replay refused");

    // ════ #76: receipt read fails after the broadcast. ════
    log("\n▶ Receipt read fails after broadcast (#76) ...");
    const signStudio = async (nonce: `0x${string}`) => {
      const t = Math.floor(Date.now() / 1000);
      const a = { from: studioBuyer.address, to: accepted.payTo, value: accepted.amount, validAfter: String(t - 30), validBefore: String(t + 600), nonce };
      const sig = await studioBuyer.signTypedData(
        buildEip3009TypedData({ chainId: 56, token: U.address, name: accepted.extra.name, version: accepted.extra.version, from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce }) as never,
      );
      return Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted, payload: { signature: sig, authorization: a } })).toString("base64");
    };
    const flakyHeader = await signStudio(toHex(crypto.getRandomValues(new Uint8Array(32))));
    const flakyBefore = await balanceOf(U.address, merchantAddr);

    failReceipts = true;
    const flakyRes = await fetch(`http://localhost:${HTTP_PORT}/audit-flaky-rpc`, { headers: { "X-PAYMENT": flakyHeader } });
    const flakyBody: any = await flakyRes.json();
    failReceipts = false;
    assert(flakyRes.status === 200, `broadcast payment is not answered with a challenge (got ${flakyRes.status}: ${JSON.stringify(flakyBody)})`);
    assert(flakyBody.settlement === "pending", `receipt reports pending (got ${flakyBody.settlement})`);
    await publicClient.waitForTransactionReceipt({ hash: flakyBody.settledTx });
    assert((await balanceOf(U.address, merchantAddr)) - flakyBefore === PRICE, "exactly one transfer landed");
    log(`  ✓ 200 + pending receipt (tx ${String(flakyBody.settledTx).slice(0, 14)}…), one transfer on-chain`);

    // The buyer never saw that 200 and asks again: same payment, now confirmed, no new transfer.
    const reaskRes = await fetch(`http://localhost:${HTTP_PORT}/audit-flaky-rpc`, { headers: { "X-PAYMENT": flakyHeader } });
    const reaskBody: any = await reaskRes.json();
    assert(reaskRes.status === 200 && reaskBody.settlement === "confirmed" && reaskBody.settledTx === flakyBody.settledTx, `re-ask returns the same settlement confirmed (got ${reaskRes.status}: ${JSON.stringify(reaskBody)})`);
    assert((await balanceOf(U.address, merchantAddr)) - flakyBefore === PRICE, "re-ask did not settle again");
    log("  ✓ re-ask → 200 confirmed, same tx, still one transfer");

    const thirdRes = await fetch(`http://localhost:${HTTP_PORT}/audit-flaky-rpc`, { headers: { "X-PAYMENT": flakyHeader } });
    assert(thirdRes.status === 402, "further replay of a confirmed authorization is refused");
    log("  ✓ replay after confirmation refused");

    // ════ Buyer B: Altana smart account paying permit2-exact USDT. ════
    log("\n▶ Buyer B (Altana smart account, permit2-exact USDT, ERC-1271) ...");
    const walletSigner = createPrivateKeySigner();
    const wallet = walletSigner.address;
    await test.setBalance({ address: wallet, value: 10n ** 20n });
    await test.setCode({ address: wallet, bytecode: concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]) });
    await dealToken(USDT_BSC.address, wallet, 10n * 10n ** 18n);

    const sessionSigner = createPrivateKeySigner();
    const session: Session = { walletAddress: wallet, signer: sessionSigner, publicKey: sessionSigner.publicKey, permissions: {}, expiry: 0 };
    const sessionPub = encodeAbiParameters([{ type: "address" }], [sessionSigner.address]);
    const keyHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, keccak256(sessionPub)]));

    await test.impersonateAccount({ address: wallet });
    const asWallet = createWalletClient({ account: wallet, chain: bsc, transport: http(ANVIL_URL) });
    for (const s of [
      { to: USDT_BSC.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, 2n ** 256n - 1n] }) },
      { to: wallet, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "authorize", args: [{ expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: sessionPub }] }) },
      { to: wallet, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setSignatureCheckerApproval", args: [keyHash, PERMIT2_ADDRESS, true] }) },
    ]) {
      const h = await asWallet.sendTransaction(s);
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
    await test.stopImpersonatingAccount({ address: wallet });

    const merchantTBefore = await balanceOf(USDT_BSC.address, merchantAddr);
    const res = await fetchWithX402(session, `http://localhost:${HTTP_PORT}/audit`, undefined, { chainId: 56, preferRail: "permit2" });
    const body: any = await res.json();
    const merchantTAfter = await balanceOf(USDT_BSC.address, merchantAddr);

    assert(res.status === 200, `Altana buyer got 200 (got ${res.status}: ${JSON.stringify(body)})`);
    assert(merchantTAfter - merchantTBefore === PRICE, `merchant received ${fmt(PRICE, "USDT")} (got ${fmt(merchantTAfter - merchantTBefore, "USDT")})`);
    log(`  ✓ 200 + ${fmt(PRICE, "USDT")} settled on-chain via permitWitnessTransferFrom (tx ${body.settledTx.slice(0, 14)}…)`);

    log("\nResult: PASS ✓ — one merchant, both buyer families, real on-chain settlement, no double charge on a flaky RPC.\n");
  } finally {
    server?.stop(true);
    proxy?.stop(true);
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
