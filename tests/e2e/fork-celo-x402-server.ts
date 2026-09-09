/**
 * FORK E2E: @altananetwork/x402-server sells on Celo Sepolia (chain 11142220).
 *
 * Everything runs against an anvil Celo Sepolia fork (real USDC, USDT and
 * Permit2 bytecode; no real funds):
 *
 *   1. A merchant charging 0.2 USDC (eip3009) or 0.2 USDT (permit2-exact)
 *      per request via `createX402Merchant` on chainId 11142220, settling
 *      through viem's `celoSepolia` chain (its custom serializer must emit a
 *      standard 0x02 transaction: no fee currency is ever set).
 *   2. Buyer A, an EOA: signs the EIP-3009 `TransferWithAuthorization` on
 *      Circle's USDC (domain name "USDC", version "2", 6 decimals). The
 *      merchant settles via `transferWithAuthorization`.
 *   3. Buyer B, an Altana smart account with a scoped session key: pays via
 *      `fetchWithX402` on the permit2-exact witness rail over USDT (6 decimals,
 *      no EIP-3009 there), ERC-1271 signature checked by Permit2 against the
 *      real Celo Sepolia account implementation.
 *   4. Replay of buyer A's header must be refused.
 *
 * Env: CELO_SEPOLIA_FORK_RPC_URL (default: public Ankr). The account
 * implementation is read from the fork; when the account stack is not
 * deployed on Celo Sepolia yet, its bytecode is copied from BNB testnet
 * (same address there) so the ERC-1271 leg still runs.
 *
 * Run: bun run fork:celo-x402-server   (from tests/e2e; needs `anvil`)
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
import { bscTestnet, celoSepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createPrivateKeySigner,
  fetchWithX402,
  buildEip3009TypedData,
  PERMIT2_ADDRESS,
  networkToChainId,
} from "@altananetwork/sdk";
import type { Session } from "@altananetwork/sdk";
import { createX402Merchant, USDC_CELO_SEPOLIA, USDT_CELO_SEPOLIA } from "@altananetwork/x402-server";

/** Testnet account implementation (same address on BNB testnet and Celo Sepolia). */
const ACCOUNT_IMPL: Address = "0x33aD2F49ab9f122f5F0FDF579f575724EfF353DE";
const CHAIN_ID = 11142220;
const CELO_RPC = process.env.CELO_SEPOLIA_FORK_RPC_URL || "https://rpc.ankr.com/celo_sepolia";
const BSC_TESTNET_RPC = process.env.BSC_TESTNET_FORK_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const ANVIL_PORT = 8558;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const HTTP_PORT = 8793;
const PRICE = 200_000n; // 0.2 tokens (6 dec)

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const ACCOUNT_ABI = [
  { name: "authorize", type: "function", stateMutability: "nonpayable", inputs: [{ name: "key", type: "tuple", components: [{ name: "expiry", type: "uint40" }, { name: "keyType", type: "uint8" }, { name: "isSuperAdmin", type: "bool" }, { name: "publicKey", type: "bytes" }] }], outputs: [{ name: "keyHash", type: "bytes32" }] },
  { name: "setSignatureCheckerApproval", type: "function", stateMutability: "nonpayable", inputs: [{ name: "keyHash", type: "bytes32" }, { name: "checker", type: "address" }, { name: "isApproved", type: "bool" }], outputs: [] },
] as const;

const test = createTestClient({ mode: "anvil", chain: celoSepolia, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: celoSepolia, transport: http(ANVIL_URL) });

function log(msg: string) { console.log(msg); }
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
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
const fmt = (v: bigint, sym: string) => `${formatUnits(v, 6)} ${sym}`;
const balanceOf = (token: Address, a: Address) =>
  publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });

async function main() {
  assert(networkToChainId("celo-sepolia") === CHAIN_ID && networkToChainId(`eip155:${CHAIN_ID}`) === CHAIN_ID, "SDK resolves the Celo Sepolia network aliases");

  log(`\n▶ Booting anvil Celo Sepolia fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", CELO_RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await waitForAnvil();
    assert((await publicClient.getChainId()) === CHAIN_ID, "fork is Celo Sepolia");
    for (const t of [USDC_CELO_SEPOLIA, USDT_CELO_SEPOLIA]) {
      const dec = await publicClient.readContract({ address: t.address, abi: ERC20_ABI, functionName: "decimals" });
      assert(dec === t.decimals, `${t.symbol} decimals on chain (${dec}) match the token config (${t.decimals})`);
    }
    assert((await publicClient.getCode({ address: PERMIT2_ADDRESS })) !== undefined, "Permit2 is deployed on Celo Sepolia");

    // The account implementation: real on the fork once the testnet stack is
    // deployed on Celo Sepolia; otherwise copied from BNB testnet.
    let implSource = "Celo Sepolia";
    if ((await publicClient.getCode({ address: ACCOUNT_IMPL })) === undefined) {
      const bsc = createPublicClient({ chain: bscTestnet, transport: http(BSC_TESTNET_RPC) });
      const code = await bsc.getCode({ address: ACCOUNT_IMPL });
      assert(!!code, "account implementation bytecode available on BNB testnet");
      await test.setCode({ address: ACCOUNT_IMPL, bytecode: code! });
      implSource = "BNB testnet (copied; not deployed on Celo Sepolia yet)";
    }
    log(`  account implementation ${ACCOUNT_IMPL} from ${implSource}`);

    // ── The merchant: payout address + funded facilitator settler. ──
    const facilitator = privateKeyToAccount(generatePrivateKey());
    const merchantAddr: Address = privateKeyToAccount(generatePrivateKey()).address;
    await test.setBalance({ address: facilitator.address, value: 10n ** 20n });

    const merchant = createX402Merchant({
      chainId: CHAIN_ID,
      payTo: merchantAddr,
      price: PRICE,
      minPrice: PRICE / 4n,
      maxPrice: PRICE * 10n,
      rails: [
        { rail: "eip3009", token: USDC_CELO_SEPOLIA },
        { rail: "permit2-exact", token: USDT_CELO_SEPOLIA, spender: facilitator.address },
      ],
      maxTimeoutSeconds: 600,
      resource: `http://localhost:${HTTP_PORT}/audit`,
      facilitator,
      rpcUrl: ANVIL_URL,
      chain: celoSepolia,
    });

    log("▶ Starting merchant service on :" + HTTP_PORT + " (0.2 USDC / 0.2 USDT per call, chain 11142220) ...");
    server = Bun.serve({
      port: HTTP_PORT,
      async fetch(req) {
        const { response, receipt } = await merchant.guard(req);
        if (response) return response;
        return new Response(
          JSON.stringify({ data: "🔮 paid capability output", settledTx: receipt!.txHash, settlement: receipt!.settlement }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    // ════ Buyer A: EOA paying eip3009 USDC. ════
    log("\n▶ Buyer A (EOA, eip3009 USDC) ...");
    const eoaBuyer = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: eoaBuyer.address, value: 10n ** 19n });
    await dealToken(USDC_CELO_SEPOLIA.address, eoaBuyer.address, 10n * 10n ** 6n);

    const challengeRes = await fetch(`http://localhost:${HTTP_PORT}/audit`);
    assert(challengeRes.status === 402, "unpaid request gets a 402 challenge");
    const challenge: any = await challengeRes.json();
    for (const a of challenge.accepts) assert(a.network === `eip155:${CHAIN_ID}`, "challenge names eip155:11142220");
    const accepted = challenge.accepts.find(
      (a: any) => a.extra?.assetTransferMethod === "eip3009" && a.asset.toLowerCase() === USDC_CELO_SEPOLIA.address.toLowerCase(),
    );
    assert(!!accepted, "challenge offers an eip3009 USDC option");
    assert(accepted.extra.name === "USDC" && accepted.extra.version === "2", "USDC EIP-712 domain advertised");

    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: eoaBuyer.address,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter: String(now - 30),
      validBefore: String(now + accepted.maxTimeoutSeconds),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signature = await eoaBuyer.signTypedData(
      buildEip3009TypedData({
        chainId: CHAIN_ID,
        token: USDC_CELO_SEPOLIA.address,
        name: accepted.extra.name,
        version: accepted.extra.version,
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      }) as never,
    );
    const eoaHeader = Buffer.from(
      JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted, payload: { signature, authorization: auth } }),
    ).toString("base64");

    const merchantUsdcBefore = await balanceOf(USDC_CELO_SEPOLIA.address, merchantAddr);
    const paidRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, { headers: { "X-PAYMENT": eoaHeader } });
    const paidBody: any = await paidRes.json();
    const merchantUsdcAfter = await balanceOf(USDC_CELO_SEPOLIA.address, merchantAddr);
    assert(paidRes.status === 200, `EOA buyer got 200 (got ${paidRes.status}: ${JSON.stringify(paidBody)})`);
    assert(merchantUsdcAfter - merchantUsdcBefore === PRICE, `merchant received ${fmt(PRICE, "USDC")} (got ${fmt(merchantUsdcAfter - merchantUsdcBefore, "USDC")})`);
    const settleTx = await publicClient.getTransaction({ hash: paidBody.settledTx });
    assert(settleTx.type === "eip1559", `settlement is a standard EIP-1559 transaction (got ${settleTx.type})`);
    log(`  ✓ 200 + ${fmt(PRICE, "USDC")} settled via transferWithAuthorization, tx type ${settleTx.type} (${paidBody.settledTx.slice(0, 14)}…)`);

    const replayRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, { headers: { "X-PAYMENT": eoaHeader } });
    assert(replayRes.status === 402, "replayed authorization is refused");
    log("  ✓ replay refused");

    // ════ Buyer B: Altana smart account paying permit2-exact USDT. ════
    log("\n▶ Buyer B (Altana smart account, permit2-exact USDT, ERC-1271) ...");
    const walletSigner = createPrivateKeySigner();
    const wallet = walletSigner.address;
    await test.setBalance({ address: wallet, value: 10n ** 20n });
    await test.setCode({ address: wallet, bytecode: concatHex(["0xef0100", ACCOUNT_IMPL]) });
    await dealToken(USDT_CELO_SEPOLIA.address, wallet, 10n * 10n ** 6n);

    const sessionSigner = createPrivateKeySigner();
    const session: Session = { walletAddress: wallet, signer: sessionSigner, publicKey: sessionSigner.publicKey, permissions: {}, expiry: 0 };
    const sessionPub = encodeAbiParameters([{ type: "address" }], [sessionSigner.address]);
    const keyHash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [2n, keccak256(sessionPub)]));

    await test.impersonateAccount({ address: wallet });
    const asWallet = createWalletClient({ account: wallet, chain: celoSepolia, transport: http(ANVIL_URL) });
    for (const s of [
      { to: USDT_CELO_SEPOLIA.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2_ADDRESS, 2n ** 256n - 1n] }) },
      { to: wallet, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "authorize", args: [{ expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: sessionPub }] }) },
      { to: wallet, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setSignatureCheckerApproval", args: [keyHash, PERMIT2_ADDRESS, true] }) },
    ]) {
      const h = await asWallet.sendTransaction({ ...s, gas: 1_000_000n });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      assert(r.status === "success", `setup call to ${s.to} succeeded`);
    }
    await test.stopImpersonatingAccount({ address: wallet });

    const merchantUsdtBefore = await balanceOf(USDT_CELO_SEPOLIA.address, merchantAddr);
    const res = await fetchWithX402(session, `http://localhost:${HTTP_PORT}/audit`, undefined, { chainId: CHAIN_ID, preferRail: "permit2" });
    const body: any = await res.json();
    const merchantUsdtAfter = await balanceOf(USDT_CELO_SEPOLIA.address, merchantAddr);
    assert(res.status === 200, `Altana buyer got 200 (got ${res.status}: ${JSON.stringify(body)})`);
    assert(merchantUsdtAfter - merchantUsdtBefore === PRICE, `merchant received ${fmt(PRICE, "USDT")} (got ${fmt(merchantUsdtAfter - merchantUsdtBefore, "USDT")})`);
    log(`  ✓ 200 + ${fmt(PRICE, "USDT")} settled via permitWitnessTransferFrom (tx ${body.settledTx.slice(0, 14)}…)`);

    log("\nResult: PASS ✓: one merchant on Celo Sepolia, both buyer families, real on-chain settlement over USDC (eip3009) and USDT (permit2-exact).\n");
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
