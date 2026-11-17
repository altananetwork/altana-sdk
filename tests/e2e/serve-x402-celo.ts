/**
 * A real x402 seller on live Celo Sepolia, for a buyer to pay for real.
 *
 * `live-x402-session-approvals.ts` buys from this, and it is a genuine
 * `@altananetwork/x402-server` merchant rather than a stub: the payment is
 * verified and settled on chain, and the answer carries the receipt, so a
 * buyer can read which rail carried it and which route settled it instead of
 * inferring either.
 *
 * It offers both rails over USDC, and a smart account can pay on either. Which
 * contract verifies the signature is what differs, and that contract must be an
 * approved signature checker for the key: `Permit2` on `permit2-exact`, the
 * token itself on `eip3009`, since a FiatTokenV2 token verifies
 * `transferWithAuthorization` in its own code and routes contract signers
 * through `SignatureChecker`. `grantSession({ x402Tokens })` sets both.
 *
 * With `X402_CELO_API_KEY` set, the rails in `FACILITATOR_RAILS` settle through
 * Celo's own facilitator, which broadcasts and pays the gas, and everything
 * else settles from the merchant's key. Without the key everything settles
 * locally. Either way `receipt.settledVia` is what says which happened.
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
/**
 * The rails this seller hands to the facilitator.
 *
 * A choice made here, not a property of the facilitator: Celo's takes a smart
 * account's signature on both rails. What it decides is only where this seller
 * sends each payment, and the receipt, not this constant, says where one went.
 */
const FACILITATOR_RAILS = ["eip3009"] as const;

const funderKey = process.env.TEST_FUNDER_KEY as `0x${string}` | undefined;
if (!funderKey) {
  throw new Error(
    "TEST_FUNDER_KEY is not set. Source the shared testnet env file first; " +
      "`testnetEnvFile()` in this directory resolves its path.",
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
          rails: FACILITATOR_RAILS,
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
          // Which rails this seller routes to the facilitator. Reported rather
          // than left for a caller to assume: it is this seller's own
          // configuration, not a limit of the facilitator.
          facilitatorRails: API_KEY ? FACILITATOR_RAILS : [],
        }),
      );
    }

    if (url.pathname !== "/paid") return withCors(Response.json({ error: "not found" }, { status: 404 }));

    const { response, receipt } = await seller.guard(req);
    if (response) return withCors(response);

    // What actually settled it, from the receipt. This used to be inferred
    // from the rail and the seller's own configuration, which was already wrong
    // before the facilitator took Permit2: a merchant configured with no
    // facilitator rails settles eip3009 locally, and the inference would still
    // have called it "facilitator".
    const settledVia = receipt!.settledVia;
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
