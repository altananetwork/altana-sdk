#!/usr/bin/env node
/**
 * Copies qa's `celo-harness/evidence/showcase-keys.json` into `public/`, where
 * the Celo mirror tab fetches it.
 *
 *   node scripts/copy-showcase-keys.mjs [path/to/showcase-keys.json]
 *
 * A copy rather than a build-time import, for the same reason `proof.json` is:
 * the source lives outside this repository, so importing it would break the
 * app for anyone who clones altana-sdk without the harness beside it, and
 * would need a rebuild every time qa re-proves a key.
 *
 * It refuses to copy a file whose `keyStoreKeyId` does not match
 * `keccak256(publicKey)`. Those two disagreeing means the card would read the
 * mirror for a different key and report "never registered" on stage, which
 * looks exactly like the feature being broken. Better to fail here, loudly,
 * than there, quietly.
 *
 * Only public keys, addresses and transaction hashes travel: everything in the
 * file is already on a public chain, and nothing secret belongs in it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const here = dirname(fileURLToPath(import.meta.url));

function findSource() {
  let dir = here;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "celo-harness", "evidence", "showcase-keys.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : findSource();
const outPath = join(here, "..", "public", "showcase-keys.json");

if (!sourcePath || !existsSync(sourcePath)) {
  console.error(
    "copy-showcase-keys: could not find celo-harness/evidence/showcase-keys.json. Pass its path:\n" +
      "  node scripts/copy-showcase-keys.mjs ../../../celo-harness/evidence/showcase-keys.json",
  );
  process.exit(1);
}

const file = JSON.parse(readFileSync(sourcePath, "utf8"));
if (!Array.isArray(file.keys)) {
  console.error("copy-showcase-keys: the file has no `keys` array.");
  process.exit(1);
}

const problems = [];
for (const k of file.keys) {
  const role = k?.role ?? "unnamed";
  if (typeof k?.publicKey !== "string" || !/^0x[0-9a-fA-F]{128,}$/.test(k.publicKey)) {
    problems.push(`${role}: publicKey is missing or not a public key`);
    continue;
  }
  if (typeof k?.user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(k.user)) {
    problems.push(`${role}: user is not an address`);
    continue;
  }
  const derived = keccak256(k.publicKey);
  if (typeof k.keyStoreKeyId === "string" && k.keyStoreKeyId.toLowerCase() !== derived.toLowerCase()) {
    problems.push(
      `${role}: keyStoreKeyId ${k.keyStoreKeyId} is not keccak256(publicKey) ${derived}. ` +
        `The card would read the mirror for a different key.`,
    );
  }
}

if (problems.length > 0) {
  console.error("copy-showcase-keys: refusing to copy.\n  " + problems.join("\n  "));
  process.exit(1);
}

writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
console.log(`copy-showcase-keys: ${file.keys.length} keys`);
for (const k of file.keys) {
  console.log(`  ${(k.role ?? "unnamed").padEnd(18)} keyType ${k.keyType ?? "?"}  ${k.user}`);
}
console.log(`wrote ${outPath}`);
