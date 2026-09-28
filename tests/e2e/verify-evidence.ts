/**
 * Check that every transaction a document cites actually exists.
 *
 * Evidence is only evidence if the links resolve. A report generated from a
 * fork run, or one written by hand from a failed run, can carry hashes that no
 * public explorer can show — and a reader who clicks one does not conclude
 * "fork result", they conclude the evidence was invented. That happened to
 * MATRIX.md on 2026-09-28: five of twelve cited transactions did not exist
 * publicly, all five fork hashes wearing public links. Nothing in CI, review or
 * the report generator caught it, because the generator was working as written.
 *
 * So this is the check, as a command rather than a recommendation.
 *
 *   bun run verify-evidence.ts <file.md> [more.md ...]
 *   bun run verify:evidence                       (the harness matrix)
 *
 * It finds every `https://<explorer>/tx/0x…` link, picks the chain from the
 * explorer host, and asks that chain for the receipt. Exit code 1 if any link
 * is dead or points at a reverted transaction, so it can gate a sign-off.
 *
 * Hashes written plain rather than linked — `0x…` (fork-local) — are ignored
 * on purpose: they are correctly marked as unverifiable in public.
 */
import { CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";

/** Explorer host -> the chain to ask. Add a row when a new explorer appears. */
const CHAINS: { host: string; name: string; rpc: string }[] = [
  { host: "sepolia.celoscan.io", name: "Celo Sepolia", rpc: process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA.publicRpcUrl },
  { host: "celo-sepolia.blockscout.com", name: "Celo Sepolia", rpc: process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA.publicRpcUrl },
  { host: "sepolia.etherscan.io", name: "Sepolia", rpc: process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl },
];

const clients = new Map<string, PublicClient>();
function clientFor(rpc: string): PublicClient {
  let c = clients.get(rpc);
  if (!c) {
    c = createPublicClient({ transport: http(rpc) }) as PublicClient;
    clients.set(rpc, c);
  }
  return c;
}

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: bun run verify-evidence.ts <file.md> [more.md ...]");
  process.exit(2);
}

type Cite = { file: string; host: string; hash: Hex };
const cites: Cite[] = [];
const seen = new Set<string>();

for (const file of files) {
  const text = await Bun.file(file).text();
  const re = /https:\/\/([a-z0-9.\-]+)\/tx\/(0x[0-9a-fA-F]{64})/g;
  for (const m of text.matchAll(re)) {
    const key = `${m[1]}:${m[2]!.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({ file, host: m[1]!, hash: m[2]! as Hex });
  }
}

console.log(`${cites.length} distinct transaction link(s) across ${files.length} file(s)\n`);

let bad = 0;
let unknownHost = 0;
for (const c of cites) {
  const chain = CHAINS.find((x) => x.host === c.host);
  if (!chain) {
    unknownHost++;
    console.log(`  ?  ${c.hash.slice(0, 20)}…  unknown explorer ${c.host}  (${c.file})`);
    continue;
  }
  let verdict: string;
  try {
    const r = await clientFor(chain.rpc).getTransactionReceipt({ hash: c.hash });
    verdict = r.status === "success" ? "ok" : `REVERTED`;
    if (r.status !== "success") bad++;
  } catch {
    verdict = "MISSING";
    bad++;
  }
  const mark = verdict === "ok" ? "  ok " : "  !! ";
  console.log(`${mark} ${c.hash.slice(0, 20)}…  ${chain.name.padEnd(13)} ${verdict}${verdict === "ok" ? "" : `  (${c.file})`}`);
}

console.log();
if (unknownHost) console.log(`${unknownHost} link(s) on an explorer this script does not know — add it to CHAINS.`);
if (bad === 0) {
  console.log(`PASS: every cited transaction exists and succeeded.`);
  process.exit(0);
}
console.log(
  `FAIL: ${bad} cited transaction(s) are missing or reverted.\n` +
    `A hash from a fork run belongs in the document as \`0x…\` (fork-local), not as a link.`,
);
process.exit(1);
