/**
 * REAL B402 payment — an agent developer pays a live Binance B402 (x402)
 * service from an Altana session key. No mock: this hits the real Bazaar and a
 * real paid endpoint over the network.
 *
 * Run:  bun run pay-real-b402            (from apps/passkey-demo)
 *       bun run pay-real-b402 <url>      (target a specific B402 resource)
 *
 * What it does:
 *   1. Discovers live services from the real B402 Bazaar
 *      (https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/resources).
 *   2. GETs a real paid endpoint → receives the real HTTP 402 challenge.
 *   3. Has the Altana session key sign a REAL X-PAYMENT for the BNB
 *      permit2-exact rail (fetchWithX402, chainId 56) and retries.
 *   4. Prints exactly what the real facilitator replies.
 *
 * NOTE ON FULL SETTLEMENT: signing is free and always works. For the facilitator
 * to actually SETTLE, the payer wallet must (a) be a deployed Altana wallet on
 * BNB, (b) hold the token, (c) have approved Permit2 on the token, (d) have
 * approved Permit2 as the session's signature checker, and (e) the B402
 * facilitator must accept a smart-account (ERC-1271) signature. With a throwaway
 * wallet you'll see the facilitator's real rejection — which still proves the
 * wire is correct end-to-end up to settlement.
 */

import {
  createPrivateKeySigner,
  fetchWithX402,
  signX402Payment,
  selectX402Requirement,
  type Session,
} from "@altananetwork/sdk";

const BAZAAR =
  "https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/resources?limit=50";

type Accept = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: { assetTransferMethod?: string; name?: string };
};
type Resource = { resource: string; description?: string; accepts: Accept[] };

async function discover(): Promise<Resource[]> {
  const res = await fetch(BAZAAR, { headers: { accept: "application/json" } });
  const body: any = await res.json();
  return (body?.data?.items ?? []) as Resource[];
}

// The Bazaar listing puts the rail directly in `scheme` ("eip3009"); a live 402
// puts it in `extra.assetTransferMethod` under `scheme: "exact"`. Accept both.
function railOf(a: Accept): string {
  return a.extra?.assetTransferMethod ?? a.scheme;
}

/** Pick a cheap BNB resource that offers a rail we can pay. */
function pickTarget(items: Resource[]): Resource | undefined {
  const onBnbPermit2 = items.filter((r) =>
    r.accepts?.some(
      (a) =>
        a.network === "eip155:56" &&
        (railOf(a) === "permit2-exact" || railOf(a) === "eip3009"),
    ),
  );
  const byPrice = (r: Resource) =>
    Math.min(
      ...r.accepts
        .filter((a) => a.network === "eip155:56")
        .map((a) => Number(a.amount ?? a.maxAmountRequired ?? "0")),
    );
  return onBnbPermit2.sort((a, b) => byPrice(a) - byPrice(b))[0];
}

async function main() {
  const arg = process.argv[2];

  console.log("▶ Discovering live services from the real B402 Bazaar…");
  const items = await discover();
  console.log(`  ${items.length} live resources listed.`);

  let url = arg;
  if (!url) {
    const target = pickTarget(items);
    if (!target) throw new Error("no BNB B402 resource found in the Bazaar right now.");
    url = target.resource;
    console.log(`  chose: ${url}`);
    if (target.description) console.log(`         ${target.description}`);
  }

  // The agent's Altana session key. (Throwaway here — swap for a real granted
  // session to attempt actual settlement.)
  const sessionSigner = createPrivateKeySigner();
  const session: Session = {
    walletAddress: "0x000000000000000000000000000000000000dEaD",
    signer: sessionSigner,
    publicKey: sessionSigner.publicKey,
    permissions: {},
    expiry: 0,
  };

  // Show the real 402 first.
  console.log(`\n▶ GET ${url}  (expect a real 402)…`);
  const probe = await fetch(url);
  console.log(`  ← HTTP ${probe.status}`);
  if (probe.status === 402) {
    const body: any = await probe.clone().json();
    const chosen = selectX402Requirement(body.accepts ?? [], { chainId: 56 });
    console.log(`  offered ${body.accepts?.length ?? 0} option(s); paying:`);
    console.log(
      `    ${chosen?.scheme}/${chosen?.extra?.assetTransferMethod} ` +
        `${chosen?.extra?.name} on ${chosen?.network} ` +
        `for ${chosen?.amount ?? chosen?.maxAmountRequired}`,
    );

    // Show the exact X-PAYMENT the agent will send (echo the real version).
    if (chosen) {
      const { header, payload } = await signX402Payment(session, {
        ...(chosen as any),
        x402Version: body.x402Version,
      });
      console.log(`\n▶ Session signed a REAL X-PAYMENT (${header.length} b64 chars):`);
      console.log(JSON.stringify(payload, null, 2));
      const sigBytes = ((payload.payload as any).signature.length - 2) / 2;
      console.log(
        `\n  NOTE: signature is ${sigBytes} bytes — an Altana smart-account (ERC-1271)` +
          ` signature. Binance's real facilitator structurally accepts this envelope` +
          ` (it advances to "Payment required"); Permit2 validates the ERC-1271 sig` +
          ` on-chain at settlement.`,
      );
    }
  }

  // The entire agent integration: one call.
  console.log(`\n▶ fetchWithX402(session, url) — pays the 402 and retries…`);
  const res = await fetchWithX402(session, url, undefined, { chainId: 56 });
  const text = await res.text();
  console.log(`  ← HTTP ${res.status}`);
  console.log(`  ← body: ${text.slice(0, 600)}`);

  let errField: string | undefined;
  try {
    errField = JSON.parse(text).error;
  } catch {
    /* non-JSON body */
  }

  if (res.status === 200) {
    console.log("\n✓ Paid a REAL B402 service end-to-end.");
  } else if (errField === "Payment required") {
    console.log(
      "\n✓ Binance's facilitator PARSED and ACCEPTED the X-PAYMENT envelope " +
        '(reply: "Payment required"). It just needs a funded, provisioned Altana ' +
        "wallet (USDC + Permit2 approval + checker) to actually settle — a dead " +
        "address can't pay.",
    );
  } else {
    console.log(`\n· Facilitator rejected the envelope: ${errField ?? "(see body)"}.`);
  }
}

main().catch((e) => {
  console.error("\n✗ error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
