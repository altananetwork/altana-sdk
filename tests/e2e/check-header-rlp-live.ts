/**
 * Re-encode a LIVE recent header on every configured chain and check it hashes
 * to the block's own hash.
 *
 * Needs no funds and no relay. It exists because the unit fixtures cannot do
 * this job: a fixture is a measurement of the day it was taken, so the suite
 * kept passing through Glamsterdam while every post-fork mirror proof was
 * unbuildable. This is the check that fails the moment a chain adds a header
 * field, which is the only warning the SDK gets.
 *
 * `buildPopulateKeyCall` refuses to build a proof when this hash does not
 * match, so a failure here means mirror proofs are already broken on that
 * chain — not that this script is wrong.
 *
 * Run: bun run check:header-rlp   (from tests/e2e)
 */
// `rlpEncodeHeader` is exported at module level but deliberately NOT from the
// package: it exists for this check and for the unit tests, and the public
// surface should not grow for a diagnostic. Imported from source accordingly.
import { rlpEncodeHeader } from "../../packages/wallet/src/syncKeyToL2.js";
import { SEPOLIA, CELO_SEPOLIA, BASE_SEPOLIA, ETHEREUM } from "@altananetwork/sdk";
import { createPublicClient, http, keccak256 } from "viem";

const CHAINS = [
  { name: "Ethereum Sepolia", rpc: process.env.SEPOLIA_RPC_URL ?? SEPOLIA.publicRpcUrl },
  { name: "Celo Sepolia", rpc: process.env.CELO_SEPOLIA_RPC_URL ?? CELO_SEPOLIA.publicRpcUrl },
  { name: "Base Sepolia", rpc: BASE_SEPOLIA.publicRpcUrl },
  { name: "Ethereum", rpc: ETHEREUM.publicRpcUrl },
];

let failed = 0;
for (const { name, rpc } of CHAINS) {
  if (!rpc) continue;
  try {
    const c = createPublicClient({ transport: http(rpc) });
    // A few blocks back, so a node that lags the head still answers.
    const head = await c.getBlockNumber({ cacheTime: 0 });
    const n = head > 8n ? head - 8n : head;
    const b: any = await c.getBlock({ blockNumber: n, includeTransactions: false });
    const got = keccak256(rlpEncodeHeader(b));
    const ok = got.toLowerCase() === String(b.hash).toLowerCase();
    const extra = ["blockAccessListHash", "slotNumber", "requestsHash", "parentBeaconBlockRoot"]
      .filter((k) => b[k] != null);
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(18)} block ${n}  late fields: ${extra.join(", ") || "none"}`);
    if (!ok) {
      failed++;
      console.log(`       computed ${got}`);
      console.log(`       expected ${b.hash}`);
      console.log(`       => this chain's header schema changed; rlpEncodeHeader needs the new field(s).`);
    }
  } catch (e) {
    console.log(`skip ${name.padEnd(18)} ${(e as Error).message.split("\n")[0].slice(0, 70)}`);
  }
}
if (failed > 0) {
  console.error(`\nResult: FAIL — ${failed} chain(s) no longer re-encode. Mirror proofs are broken there.`);
  process.exit(1);
}
console.log("\nResult: PASS — every reachable chain's live header re-encodes to its own hash.");
