/**
 * DEV HARNESS: boots an anvil BNB-mainnet fork + an @altananetwork/x402-server
 * merchant, and stays up — for validating real external buyers (e.g. the
 * `bag x402 trust/buy` CLI from bnbagent-studio) against the package.
 *
 *   anvil RPC:  http://127.0.0.1:8549   (point STUDIO_BSC_RPC here)
 *   merchant:   http://127.0.0.1:8791/audit   (0.2 $U per call)
 *   dev fund:   GET /dev/fund?address=0x…     (deals 10 $U on the fork)
 *
 * Run: bun run serve:x402-fork   (from tests/e2e; Ctrl-C to stop)
 */
import {
  createTestClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  keccak256,
  pad,
  toHex,
  type Address,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createX402Merchant, U_TOKEN, USDT_BSC } from "@altananetwork/x402-server";

const U = U_TOKEN[56];
const BSC_RPC = process.env.BSC_FORK_RPC_URL ?? "https://bsc-dataseed.binance.org";
const ANVIL_PORT = 8549;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const HTTP_PORT = 8791;
const PRICE = 200_000_000_000_000_000n; // 0.2 $U

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const test = createTestClient({ mode: "anvil", chain: bsc, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bsc, transport: http(ANVIL_URL) });

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
  throw new Error(`balances slot not found for ${token}`);
}

const anvil = Bun.spawn(["anvil", "--fork-url", BSC_RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
await waitForAnvil();

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
  // ≤480s: Studio's signer caps the window at 600s AND backdates validAfter
  // by 120s — a 600s challenge would produce a 720s window and be refused.
  maxTimeoutSeconds: 300,
  resource: `http://localhost:${HTTP_PORT}/audit`,
  facilitator,
  rpcUrl: ANVIL_URL,
  chain: bsc,
});

Bun.serve({
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/dev/fund") {
      const address = url.searchParams.get("address") as Address;
      await dealToken(U.address, address, 10n * 10n ** 18n);
      await test.setBalance({ address, value: 10n ** 19n });
      return Response.json({ funded: address, u: "10" });
    }
    if (url.pathname === "/dev/merchant-balance") {
      const bal = await publicClient.readContract({ address: U.address, abi: ERC20_ABI, functionName: "balanceOf", args: [merchantAddr] });
      return Response.json({ merchant: merchantAddr, u: bal.toString() });
    }
    if (url.pathname !== "/audit") return Response.json({ error: "not found" }, { status: 404 });

    const { response, receipt } = await merchant.guard(req);
    if (response) return response;
    console.log(`✓ settled ${receipt!.amount} from ${receipt!.payer} (${receipt!.rail}) tx ${receipt!.txHash}`);
    return Response.json({ data: "🔮 paid capability output", settledTx: receipt!.txHash });
  },
});

console.log(`anvil fork:  ${ANVIL_URL}`);
console.log(`merchant:    http://127.0.0.1:${HTTP_PORT}/audit  (0.2 $U or 0.2 USDT per call)`);
console.log(`merchant payTo: ${merchantAddr}`);
console.log(`READY`);
