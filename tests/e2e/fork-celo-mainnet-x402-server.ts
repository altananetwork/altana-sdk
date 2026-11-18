/**
 * FORK E2E: @altananetwork/x402-server sells on Celo mainnet (chain 42220) in
 * each of its three dollar tokens.
 *
 * Everything runs against an anvil Celo mainnet fork (real USDC, USD₮ and USA₮
 * bytecode; no real funds):
 *
 *   1. One merchant charging 0.2 per request, with an eip3009 rail for each of
 *      `USDC_CELO`, `USDT_CELO` and `USAT_CELO`, settling through viem's `celo`
 *      chain from its own settler key.
 *   2. For each token, an EOA buyer signs `TransferWithAuthorization` over the
 *      EIP-712 domain the challenge advertises, which is the token config's
 *      name and version. The merchant settles with `transferWithAuthorization`
 *      and the payout address receives exactly the price.
 *   3. A replay of each header is refused.
 *
 * What it proves: the three mainnet token configs are the ones the tokens
 * accept, USA₮ included, and that USD₮ on Celo settles on the eip3009 rail.
 *
 * Env: CELO_FORK_RPC_URL (default: public forno).
 *
 * Run: bun run fork:celo-mainnet-x402-server   (from tests/e2e; needs `anvil`)
 */

import {
  createTestClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildEip3009TypedData, networkToChainId } from "@altananetwork/sdk";
import { createX402Merchant, USAT_CELO, USDC_CELO, USDT_CELO, type TokenConfig } from "@altananetwork/x402-server";
import { startAnvil, waitForAnvil } from "./anvil.js";

const CHAIN_ID = 42220;
const CELO_RPC = process.env.CELO_FORK_RPC_URL || "https://forno.celo.org";
const ANVIL_PORT = 8563;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const HTTP_PORT = 8794;
const PRICE = 200_000n; // 0.2 tokens (6 dec)
const TOKENS: readonly TokenConfig[] = [USDC_CELO, USDT_CELO, USAT_CELO];

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const test = createTestClient({ mode: "anvil", chain: celo, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: celo, transport: http(ANVIL_URL) });

function log(msg: string) { console.log(msg); }
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
const balanceOf = (token: Address, a: Address) =>
  publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
const fmt = (v: bigint, sym: string) => `${formatUnits(v, 6)} ${sym}`;

/** Writes a token balance on the fork by finding the balances mapping slot. */
async function dealToken(token: Address, holder: Address, amount: bigint) {
  for (let slot = 0; slot < 80; slot++) {
    const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
    const before = await publicClient.getStorageAt({ address: token, slot: key });
    await test.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
    if ((await balanceOf(token, holder)) === amount) return;
    await test.setStorageAt({ address: token, index: key, value: (before ?? pad("0x0")) as Hex });
  }
  throw new Error(`balances slot not found for ${token}`);
}

async function main() {
  assert(networkToChainId("celo") === CHAIN_ID && networkToChainId(`eip155:${CHAIN_ID}`) === CHAIN_ID, "SDK resolves the Celo network aliases");

  log(`\n▶ Booting anvil Celo mainnet fork (${ANVIL_URL}) ...`);
  const anvil = startAnvil(CELO_RPC, ANVIL_PORT);
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await waitForAnvil(anvil);
    assert((await publicClient.getChainId()) === CHAIN_ID, "fork is Celo mainnet");
    for (const t of TOKENS) {
      const [dec, sym] = await Promise.all([
        publicClient.readContract({ address: t.address, abi: ERC20_ABI, functionName: "decimals" }),
        publicClient.readContract({ address: t.address, abi: ERC20_ABI, functionName: "symbol" }),
      ]);
      assert(dec === t.decimals, `${t.symbol} decimals on chain (${dec}) match the token config (${t.decimals})`);
      assert(sym === t.symbol, `${t.symbol} symbol on chain ("${sym}") matches the token config`);
    }

    // ── The merchant: payout address + funded settler, one eip3009 rail per token. ──
    const facilitator = privateKeyToAccount(generatePrivateKey());
    const merchantAddr: Address = privateKeyToAccount(generatePrivateKey()).address;
    await test.setBalance({ address: facilitator.address, value: 10n ** 20n });

    const merchant = createX402Merchant({
      chainId: CHAIN_ID,
      payTo: merchantAddr,
      price: PRICE,
      minPrice: PRICE / 4n,
      maxPrice: PRICE * 10n,
      rails: TOKENS.map((token) => ({ rail: "eip3009" as const, token })),
      maxTimeoutSeconds: 600,
      resource: `http://localhost:${HTTP_PORT}/audit`,
      facilitator,
      rpcUrl: ANVIL_URL,
      chain: celo,
    });

    log("▶ Starting merchant service on :" + HTTP_PORT + " (0.2 USDC / USD₮ / USA₮ per call, chain 42220) ...");
    server = Bun.serve({
      port: HTTP_PORT,
      async fetch(req) {
        const { response, receipt } = await merchant.guard(req);
        if (response) return response;
        return new Response(
          JSON.stringify({ data: "paid capability output", settledTx: receipt!.txHash, settlement: receipt!.settlement, settledVia: receipt!.settledVia }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    for (const token of TOKENS) {
      log(`\n▶ EOA buyer pays ${fmt(PRICE, token.symbol)} (eip3009) ...`);
      const buyer = privateKeyToAccount(generatePrivateKey());
      await dealToken(token.address, buyer.address, 10n * 10n ** 6n);

      const challengeRes = await fetch(`http://localhost:${HTTP_PORT}/audit`);
      assert(challengeRes.status === 402, "unpaid request gets a 402 challenge");
      const challenge: any = await challengeRes.json();
      const accepted = challenge.accepts.find(
        (a: any) => a.extra?.assetTransferMethod === "eip3009" && a.asset.toLowerCase() === token.address.toLowerCase(),
      );
      assert(!!accepted, `challenge offers an eip3009 ${token.symbol} option`);
      assert(accepted.network === `eip155:${CHAIN_ID}`, "challenge names eip155:42220");
      assert(
        accepted.extra.name === token.name && accepted.extra.version === token.version,
        `${token.symbol} EIP-712 domain advertised as "${token.name}" / "${token.version}"`,
      );

      const now = Math.floor(Date.now() / 1000);
      const auth = {
        from: buyer.address,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: String(now - 30),
        validBefore: String(now + accepted.maxTimeoutSeconds),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
      };
      const signature = await buyer.signTypedData(
        buildEip3009TypedData({
          chainId: CHAIN_ID,
          token: token.address,
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
      const header = Buffer.from(
        JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted, payload: { signature, authorization: auth } }),
      ).toString("base64");

      const before = await balanceOf(token.address, merchantAddr);
      const paidRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, { headers: { "X-PAYMENT": header } });
      const paidBody: any = await paidRes.json();
      const after = await balanceOf(token.address, merchantAddr);
      assert(paidRes.status === 200, `buyer got 200 (got ${paidRes.status}: ${JSON.stringify(paidBody)})`);
      assert(after - before === PRICE, `merchant received ${fmt(PRICE, token.symbol)} (got ${fmt(after - before, token.symbol)})`);
      assert(paidBody.settledVia === "merchant", `settled from the merchant's own key (got ${paidBody.settledVia})`);
      const settleTx = await publicClient.getTransaction({ hash: paidBody.settledTx });
      assert(settleTx.type === "eip1559", `settlement is a standard EIP-1559 transaction (got ${settleTx.type})`);
      log(`  ✓ 200 + ${fmt(PRICE, token.symbol)} settled via transferWithAuthorization (${paidBody.settledTx.slice(0, 14)}…)`);

      const replayRes = await fetch(`http://localhost:${HTTP_PORT}/audit`, { headers: { "X-PAYMENT": header } });
      assert(replayRes.status === 402, "replayed authorization is refused");
      log("  ✓ replay refused");
    }

    log("\nResult: PASS ✓: one merchant on Celo mainnet, real on-chain settlement over USDC, USD₮ and USA₮ on the eip3009 rail.\n");
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
