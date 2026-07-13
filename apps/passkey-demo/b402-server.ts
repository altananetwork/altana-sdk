/**
 * Local B402 (x402) service for the passkey demo's "Pay & fetch" button.
 *
 * Run it:   bun run b402      (from apps/passkey-demo)
 * Then in the browser demo, "Pay & fetch" against:
 *           http://localhost:8788/premium   (pre-filled in the URL box)
 *
 * The flow it drives — exactly what `fetchWithX402(session, url)` speaks:
 *   1. GET /premium with no X-PAYMENT  → 402 + payment requirements (Permit2,
 *      BNB Smart Chain, 0.5 USDT). The SDK reads `accepts[0]`, has the session
 *      key sign a Permit2 `PermitTransferFrom` off-chain, base64s it into an
 *      `X-PAYMENT` header, and retries.
 *   2. GET /premium with X-PAYMENT     → this server (acting as the merchant +
 *      facilitator) decodes the header, checks the authorization matches what it
 *      asked for, and returns 200 + the premium content.
 *
 * MODE: this is a MOCK facilitator — it validates the signed authorization's
 * SHAPE and prints it, but does NOT broadcast the Permit2 transfer on-chain.
 * That keeps the browser demo runnable with zero funds. The identical payload,
 * settled for real against deployed Permit2 bytecode on a BNB fork, is proven
 * end-to-end in tests/e2e/demo-b402.ts (merchant balance actually increases).
 *
 * CORS is enabled (incl. the X-PAYMENT preflight) so the Vite dev origin can
 * call it from the browser.
 */

const PORT = 8788;

// What the merchant charges. Mirrors SAMPLE_X402_REQUIREMENT in src/main.ts.
const USDT = "0x55d398326f99059fF775485246999027B3197955"; // BSC-USDT (18 dec)
const PRICE = "500000000000000000"; // 0.5 USDT
const MERCHANT = "0x000000000000000000000000000000000000dEaD";
// The facilitator EOA that would call Permit2.permitTransferFrom (bound as the
// Permit2 `spender`). A real deployment funds this key to settle on-chain.
const FACILITATOR = "0x0000000000000000000000000000000000000001";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-PAYMENT, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/** The 402 challenge — the payment requirements the SDK will sign against. */
function paymentRequired(): Response {
  return json(
    {
      x402Version: 1,
      error: "payment required",
      accepts: [
        {
          scheme: "permit2",
          network: "bsc",
          asset: USDT,
          maxAmountRequired: PRICE,
          payTo: MERCHANT,
          maxTimeoutSeconds: 600,
          extra: { spender: FACILITATOR },
        },
      ],
    },
    402,
  );
}

/** Validate a decoded X-PAYMENT against what we asked for. */
function checkPayment(decoded: any): string | null {
  if (decoded?.scheme !== "permit2") return `unexpected scheme "${decoded?.scheme}"`;
  const p = decoded?.payload;
  if (!p) return "missing payload";
  if (!p.from || !/^0x[0-9a-fA-F]{40}$/.test(p.from)) return "missing/invalid payer (from)";
  if (!p.signature || !/^0x[0-9a-fA-F]+$/.test(p.signature)) return "missing/invalid signature";
  if (p.permit?.permitted?.token?.toLowerCase() !== USDT.toLowerCase())
    return `wrong token (${p.permit?.permitted?.token})`;
  if (p.permit?.permitted?.amount !== PRICE)
    return `wrong amount (${p.permit?.permitted?.amount}, want ${PRICE})`;
  if (p.permit?.spender?.toLowerCase() !== FACILITATOR.toLowerCase())
    return `wrong spender (${p.permit?.spender})`;
  return null;
}

Bun.serve({
  port: PORT,
  fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (pathname === "/" || pathname === "/health") {
      return json(
        { service: "mock B402 (x402) facilitator", pay: `GET http://localhost:${PORT}/premium` },
        200,
      );
    }

    if (pathname !== "/premium") return json({ error: "not found" }, 404);

    const xPayment = req.headers.get("X-PAYMENT");
    if (!xPayment) {
      console.log("→ 402  (no X-PAYMENT yet — sending payment requirements)");
      return paymentRequired();
    }

    // The agent paid. Decode the session-signed authorization and inspect it.
    let decoded: any;
    try {
      decoded = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8"));
    } catch {
      return json({ error: "X-PAYMENT is not valid base64 JSON" }, 400);
    }

    console.log("\n← X-PAYMENT received. Session-signed authorization:");
    console.log(JSON.stringify(decoded, null, 2));

    const problem = checkPayment(decoded);
    if (problem) {
      console.log(`✗ rejected: ${problem}\n`);
      return json({ error: `invalid payment: ${problem}` }, 402);
    }

    console.log(
      `✓ payer ${decoded.payload.from} authorized 0.5 USDT to Permit2 spender ${FACILITATOR}.`,
    );
    console.log(
      "  (mock: not broadcasting settlement — see tests/e2e/demo-b402.ts for the real on-chain settle)\n",
    );
    return json(
      {
        data: "🔮 premium oracle: BTC=$102,431 — sentiment bullish",
        settled: false,
        note: "mock facilitator — authorization verified but not broadcast on-chain",
      },
      200,
    );
  },
});

console.log(`\n  B402 (x402) mock service listening on http://localhost:${PORT}`);
console.log(`  Point the demo's "Pay & fetch" at:  http://localhost:${PORT}/premium`);
console.log(`  Price: 0.5 USDT (Permit2 / BNB Smart Chain)\n`);
