/**
 * The x402 seller the test bench's x402 panel buys from, on live Celo Sepolia.
 *
 * It is a real `@altananetwork/x402-server` merchant, not a stub: the buyer's
 * payment is verified and settled on chain, and the response carries the
 * receipt so the panel can say which rail actually carried it rather than
 * guessing from the requirement it signed.
 *
 * Two rails, because the two buyer families cannot use the same one:
 *
 * - `permit2-exact` over USDC. Permit2 verifies an ERC-1271 signature, so this
 *   is the rail an Altana smart account can pay on.
 * - `eip3009` over USDC. Celo Sepolia's USDC checks that signature with
 *   `ecrecover` and knows nothing about ERC-1271, so this rail is for a plain
 *   EOA buyer only (evidence/2026-09-29-x402-celo-facilitator.md).
 *
 * With `X402_CELO_API_KEY` set it settles the `eip3009` rail through Celo's own
 * facilitator, which broadcasts and pays the gas; the Permit2 rail keeps
 * settling from the merchant's key either way, because the facilitator does not
 * take it. Without the key everything settles locally and the panel says so.
 *
 * Run: bun run serve:x402-celo   (from tests/e2e; Ctrl-C to stop)
 */
import { type Address } from "viem";
import { celoSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  CELO_SEPOLIA_FACILITATOR_URL,
  USDC_CELO_SEPOLIA,
  createX402Merchant,
} from "@altananetwork/x402-server";

const PORT = Number(process.env.X402_CELO_PORT ?? 4021);
const RPC = process.env.CELO_SEPOLIA_RPC_URL ?? "https://forno.celo-sepolia.celo-testnet.org";
const PRICE = 10_000n; // 0.01 USDC, 6 decimals
const API_KEY = process.env.X402_CELO_API_KEY;

const funderKey = process.env.TEST_FUNDER_KEY as `0x${string}` | undefined;
if (!funderKey) {
  throw new Error(
    "TEST_FUNDER_KEY is not set. Source the shared testnet env file first: " +
      "set -a; source <repo>/../.env.testnet; set +a",
  );
}
// The merchant's own key broadcasts a locally settled payment and pays its gas.
// It is also the payout address, so a bench run needs no second wallet.
const merchant = privateKeyToAccount(funderKey);

const RESOURCE = `http://127.0.0.1:${PORT}/paid`;

const seller = createX402Merchant({
  chainId: 11142220,
  payTo: merchant.address,
  price: PRICE,
  minPrice: PRICE,
  maxPrice: PRICE * 100n,
  rails: [
    { rail: "permit2-exact", token: USDC_CELO_SEPOLIA, spender: merchant.address },
    { rail: "eip3009", token: USDC_CELO_SEPOLIA },
  ],
  maxTimeoutSeconds: 300,
  resource: RESOURCE,
  facilitator: merchant,
  rpcUrl: RPC,
  chain: celoSepolia,
  ...(API_KEY
    ? {
        facilitatorService: {
          url: CELO_SEPOLIA_FACILITATOR_URL,
          apiKey: API_KEY,
          rails: ["eip3009"] as const,
        },
      }
    : {}),
});

/**
 * The bench runs on another port, so every answer needs these.
 *
 * `payment-signature` is load-bearing and easy to miss: `fetchWithX402` sets
 * **two** headers, `X-PAYMENT` and `PAYMENT-SIGNATURE`, because some b402
 * merchants read the second one (see `fetchWithX402` in the wallet package).
 * A browser preflight refuses any header not listed here, so leaving it out
 * blocks the request client-side: the panel reports "Failed to fetch" and this
 * seller logs nothing at all, because the request never reached it.
 *
 * Only a browser meets this. A server-side fetch sends no preflight, so the
 * same purchase through the SDK passes against a seller that would fail in the
 * page (qa, 2026-09-29).
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-payment, payment-signature",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "x-payment-response",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return withCors(
        Response.json({
          ok: true,
          chainId: 11142220,
          payTo: merchant.address,
          price: PRICE.toString(),
          token: USDC_CELO_SEPOLIA.address,
          rails: ["permit2-exact", "eip3009"],
          facilitator: API_KEY ? CELO_SEPOLIA_FACILITATOR_URL : null,
        }),
      );
    }

    if (url.pathname !== "/paid") return withCors(Response.json({ error: "not found" }, { status: 404 }));

    const { response, receipt } = await seller.guard(req);
    if (response) return withCors(response);

    const settledVia = API_KEY && receipt!.rail === "eip3009" ? "facilitator" : "merchant key";
    console.log(
      `paid ${receipt!.amount} by ${receipt!.payer} on ${receipt!.rail} via ${settledVia}: ${receipt!.txHash} (${receipt!.settlement})`,
    );
    return withCors(
      Response.json({
        data: "The paid answer the seller charges for.",
        rail: receipt!.rail,
        settledVia,
        settlement: receipt!.settlement,
        txHash: receipt!.txHash,
        payer: receipt!.payer,
        amount: receipt!.amount.toString(),
      }),
    );
  },
});

console.log(`x402 seller on Celo Sepolia: ${RESOURCE}`);
console.log(`price: 0.01 USDC per request, payTo ${merchant.address as Address}`);
console.log(
  API_KEY
    ? `eip3009 settles through Celo's facilitator (${CELO_SEPOLIA_FACILITATOR_URL}); permit2 settles from the merchant key.`
    : "X402_CELO_API_KEY is not set, so everything settles from the merchant key.",
);
console.log("READY");
