/**
 * LIVE (BNB Chain mainnet, production relay, read-only) — token discovery
 * through `client.holdings`.
 *
 * Asks the production relay which tokens HOLDER owns on chain 56 and checks
 * that SPCXB shows up with a non-zero raw amount and a display value. The
 * default holder is a PancakeSwap v3 pool that holds SPCXB, so the assertion
 * is stable without any key or funding. No anvil, no signer, nothing written.
 *
 * This passes only once the relay serves `wallet_getAssets` with the wallet's
 * discovered ERC-20 holdings. Until then it exits non-zero with a message
 * saying so, rather than pretending the feature works.
 *
 * Run:  bun run live-holdings.ts
 *       HOLDER=0x… bun run live-holdings.ts
 *       RELAY_URL=http://127.0.0.1:9219 bun run live-holdings.ts   (a local relay)
 */
import type { Address } from "viem";
import { createClient, BNB } from "@altananetwork/sdk";

const HOLDER = (process.env.HOLDER ?? "0x977DaFFC095b33872E2741c19568925015C35b4d") as Address;
const SPCXB: Address = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

// RELAY_URL points the check at a relay other than production (e.g. a local build).
const network = process.env.RELAY_URL ? { ...BNB, relayUrl: process.env.RELAY_URL } : BNB;
const client = createClient({ chains: [network] });
console.log(`holdings for ${HOLDER} on chain ${network.chainId} via ${network.relayUrl}`);

let res: Awaited<ReturnType<typeof client.holdings>>;
try {
  res = await client.holdings({ wallet: HOLDER });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/method not found|not supported|-32601/i.test(msg)) {
    fail(
      `the production relay does not serve wallet_getAssets yet — deploy the relay change first.\n  ${msg}`,
    );
  }
  fail(`client.holdings threw: ${msg}`);
}

console.log(`native: ${res.native} wei`);
console.log(`tokens discovered: ${res.tokens.length}`);
for (const t of res.tokens) {
  console.log(t.ok ? `  ${t.symbol.padEnd(8)} ${t.display.padStart(28)}  ${t.address}` : `  (failed) ${t.address}: ${t.error}`);
}

const spcxb = res.tokens.find((t) => t.address.toLowerCase() === SPCXB);
if (!spcxb) {
  fail(
    `SPCXB (${SPCXB}) is not in the ${res.tokens.length} discovered token(s). ` +
      `Either the relay does not list the wallet's holdings yet (only fee tokens), or HOLDER no longer holds SPCXB.`,
  );
}
if (!spcxb.ok) fail(`SPCXB was listed but its read failed: ${spcxb.error}`);
if (spcxb.raw === 0n) fail("SPCXB was listed but its live raw balance is 0");
if (!spcxb.display || spcxb.display === "0") fail(`SPCXB has no display value (got ${JSON.stringify(spcxb.display)})`);

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
console.log(`\nSPCXB: ${JSON.stringify(spcxb, bigintSafe, 2)}`);
console.log("\nOK: SPCXB discovered with a non-zero balance and a display value.");
