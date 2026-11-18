/**
 * The live proof of an x402 payment on Celo mainnet: an Altana seller charges
 * for one request, a buyer pays in a Celo stablecoin, and the seller settles
 * the payment on chain from its own settler key.
 *
 *   0. token    the token config against the chain (symbol, decimals)
 *   1. parties  the seller's Altana wallet (payout), its settler (gas only)
 *               and the buyer, with what each holds
 *   2. 402      the seller's challenge for an unpaid request
 *   3. pay      (with --send) the buyer signs a TransferWithAuthorization for
 *               the price, the seller verifies it and settles it with
 *               `transferWithAuthorization`; the buyer's balance drops by the
 *               price and the seller's wallet receives it
 *
 * The seller is `@altananetwork/x402-server`, served on this machine for the
 * one request. Its payout address is the Altana wallet of
 * MAINNET_TEST_CELO_KEY, and the same key's account sends the settlement
 * transaction and pays its gas in CELO. The buyer is the account of
 * MAINNET_TEST_USDC_KEY: it signs, and sends nothing itself.
 *
 * WITHOUT `--send` THIS IS A DRY RUN: it reads, starts the seller, prints the
 * challenge, and signs and sends nothing. A send also needs `--i-am-doris`
 * and a phrase typed at an interactive terminal.
 *
 *   --token usdc|usdt|usat   the token to charge in (default usdc)
 *   --price 0.01             the price in whole tokens (default 0.01)
 *
 * Keys come from the environment and are never printed:
 *   set -a; source <ecosystem>/.env.mainnet; set +a
 * Optional: CELO_MAINNET_RPC_URL for reads and the settlement.
 *
 * Run (from tests/e2e):
 *   bun run live:celo-x402
 *   bun run live:celo-x402 -- --send --i-am-doris
 */
import { buildEip3009TypedData, CELO, type NetworkConfig } from "@altananetwork/sdk";
import { createX402Merchant, USAT_CELO, USDC_CELO, USDT_CELO, type TokenConfig } from "@altananetwork/x402-server";
import { createPublicClient, formatEther, formatUnits, http, parseUnits, toHex, type Address, type Hex } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { celoMainnetForScript, confirmMainnetSend, transactionLine } from "./mainnet-guard.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SEND = flag("--send");
const { network, rehearsal: REHEARSAL } = celoMainnetForScript<NetworkConfig>(CELO);
const CHAIN_ID = network.chainId;
const NAME = network.chain.name;
const PORT = Number(process.env.X402_PROOF_PORT ?? 8797);
const RESOURCE = `http://127.0.0.1:${PORT}/report`;

const TOKENS: Record<string, TokenConfig> = { usdc: USDC_CELO, usdt: USDT_CELO, usat: USAT_CELO };
const tokenName = (option("--token") ?? "usdc").toLowerCase();
function tokenNamed(name: string): TokenConfig {
  const found = TOKENS[name];
  if (!found) throw new Error(`unknown --token "${name}": use usdc, usdt or usat`);
  return found;
}
const token = tokenNamed(tokenName);
const PRICE = parseUnits(option("--price") ?? "0.01", token.decimals);

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`    ok: ${what}`);
}

async function main() {
  console.log(`@altananetwork/x402-server live proof: one paid request on ${NAME} (chain ${CHAIN_ID}), ${SEND ? "SENDING" : "dry run"}${REHEARSAL ? " (REHEARSAL on a local fork, no real funds)" : ""}`);
  const pub = createPublicClient({ chain: celo, transport: http(network.publicRpcUrl) });
  const fmt = (v: bigint) => `${formatUnits(v, token.decimals)} ${token.symbol}`;
  const tokenBalance = (a: Address) => pub.readContract({ address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });

  console.log("\n[0] the token");
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address: token.address, abi: ERC20_ABI, functionName: "decimals" }),
    pub.readContract({ address: token.address, abi: ERC20_ABI, functionName: "symbol" }),
  ]);
  check(decimals === token.decimals && symbol === token.symbol, `${token.symbol} at ${token.address}: ${decimals} decimals, as the package's token config says`);

  console.log("\n[1] the parties");
  const sellerKey = process.env.MAINNET_TEST_CELO_KEY as Hex;
  const buyerKey = process.env.MAINNET_TEST_USDC_KEY as Hex;
  if (!sellerKey || !buyerKey) throw new Error("Set MAINNET_TEST_CELO_KEY and MAINNET_TEST_USDC_KEY (set -a; source <ecosystem>/.env.mainnet; set +a).");
  const settler = privateKeyToAccount(sellerKey);
  const buyer = privateKeyToAccount(buyerKey);
  const payTo = settler.address;
  const sellerCode = await pub.getCode({ address: payTo });
  check(sellerCode && sellerCode !== "0x", `the seller's payout address ${payTo} is an Altana wallet set up on ${NAME}`);
  const [settlerCelo, buyerToken, sellerToken] = await Promise.all([pub.getBalance({ address: settler.address }), tokenBalance(buyer.address), tokenBalance(payTo)]);
  console.log(`    seller wallet ${payTo}: ${fmt(sellerToken)}; its key pays the settlement gas from ${formatEther(settlerCelo)} CELO`);
  console.log(`    buyer ${buyer.address}: ${fmt(buyerToken)}`);

  const merchant = createX402Merchant({
    chainId: CHAIN_ID,
    payTo,
    price: PRICE,
    rails: [{ rail: "eip3009", token }],
    maxTimeoutSeconds: 300,
    resource: RESOURCE,
    facilitator: settler,
    rpcUrl: network.publicRpcUrl,
    chain: celo,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(req) {
      const { response, receipt } = await merchant.guard(req);
      if (response) return response;
      return Response.json({ report: "paid content", settledTx: receipt!.txHash, settlement: receipt!.settlement, settledVia: receipt!.settledVia });
    },
  });

  try {
    console.log("\n[2] the seller's challenge for an unpaid request");
    const challengeRes = await fetch(RESOURCE);
    check(challengeRes.status === 402, "an unpaid request is answered with 402 Payment Required");
    const challenge: any = await challengeRes.json();
    const accepted = challenge.accepts.find((a: any) => a.extra?.assetTransferMethod === "eip3009" && a.asset.toLowerCase() === token.address.toLowerCase());
    check(accepted, `the challenge offers ${token.symbol} on the eip3009 rail`);
    check(accepted.network === `eip155:${CHAIN_ID}`, `it names the network as eip155:${CHAIN_ID}`);
    check(BigInt(accepted.amount) === PRICE && accepted.payTo.toLowerCase() === payTo.toLowerCase(), `it asks for ${fmt(PRICE)}, paid to the seller's wallet`);

    if (!SEND) {
      const short = [buyerToken < PRICE ? `the buyer needs ${fmt(PRICE)}` : "", settlerCelo === 0n ? "the seller's key needs CELO for the settlement gas" : ""].filter(Boolean);
      console.log(`\nDry run: nothing was signed or sent.${short.length ? ` Before a send: ${short.join("; ")}.` : " A send would pay the request."}`);
      return;
    }
    if (buyerToken < PRICE) throw new Error(`The buyer holds ${fmt(buyerToken)}, less than the price ${fmt(PRICE)}. Nothing was sent.`);
    if (settlerCelo === 0n) throw new Error("The seller's key holds no CELO for the settlement gas. Nothing was sent.");
    await confirmMainnetSend({ args, what: `${fmt(PRICE)} from ${buyer.address} and settlement gas from ${settler.address} on ${NAME}`, phrase: "spend real funds" });

    console.log("\n[3] the buyer pays, the seller settles");
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: buyer.address,
      to: accepted.payTo as Address,
      value: accepted.amount as string,
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
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      }) as never,
    );
    const header = Buffer.from(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted, payload: { signature, authorization } })).toString("base64");
    const paidRes = await fetch(RESOURCE, { headers: { "X-PAYMENT": header } });
    const paid: any = await paidRes.json();
    check(paidRes.status === 200, `the paid request is answered with 200 (got ${paidRes.status}${paidRes.status === 200 ? "" : `: ${JSON.stringify(paid).slice(0, 300)}`})`);
    check(paid.settledVia === "merchant", "the seller settled it from its own key");
    const receipt = await pub.waitForTransactionReceipt({ hash: paid.settledTx });
    check(receipt.status === "success", "the settlement transaction succeeded on chain");
    const [buyerAfter, sellerAfter] = await Promise.all([tokenBalance(buyer.address), tokenBalance(payTo)]);
    check(buyerToken - buyerAfter === PRICE, `the buyer paid exactly ${fmt(PRICE)}`);
    check(sellerAfter - sellerToken === PRICE, `the seller's wallet received exactly ${fmt(PRICE)}`);
    const replay = await fetch(RESOURCE, { headers: { "X-PAYMENT": header } });
    check(replay.status === 402, "the same payment cannot be used twice");

    console.log(`\nResult: PASS. ${fmt(PRICE)} paid over x402 on ${NAME}, settled by the seller.`);
    console.log(`    settlement: ${transactionLine(network.explorer, paid.settledTx, REHEARSAL)}`);
  } finally {
    server.stop(true);
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
