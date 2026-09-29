#!/usr/bin/env node
/**
 * Turns qa's `MATRIX.md` into `public/proof.json`, which the test bench's
 * Proof view renders.
 *
 * The matrix is the single source of truth and it is a document, not a
 * database, so this reads it rather than asking anyone to keep a second copy
 * in step. Re-run it after every matrix update:
 *
 *   node scripts/build-proof.mjs [path/to/MATRIX.md] [path/to/proof.json]
 *
 * Defaults resolve the matrix at `celo-harness/MATRIX.md` above this repo,
 * which is where it lives, and write `public/proof.json` here.
 *
 * What it takes from each table row: the item, its title, its status, which
 * relay proved it, and every link in the note. What it does not do is judge:
 * an unrecognised status becomes `other` and is rendered as written, so a new
 * status value in the matrix shows up in the view instead of vanishing.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Looks for celo-harness/MATRIX.md at or above this app, like the e2e env file. */
function findMatrix() {
  let dir = here;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "celo-harness", "MATRIX.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const matrixPath = process.argv[2] ? resolve(process.argv[2]) : findMatrix();
const outPath = process.argv[3] ? resolve(process.argv[3]) : join(here, "..", "public", "proof.json");

if (!matrixPath || !existsSync(matrixPath)) {
  console.error(
    "build-proof: could not find MATRIX.md. Pass its path:\n" +
      "  node scripts/build-proof.mjs ../../../celo-harness/MATRIX.md",
  );
  process.exit(1);
}

const text = readFileSync(matrixPath, "utf8");

/** Maps the matrix's status words onto the few states the view colours. */
export function classify(status) {
  const s = status.toLowerCase();
  // Match the opening paren only: the matrix qualifies a status inside it, as
  // in "Proven (fork, funder check stubbed)", and reading that as live would
  // put a green badge on the one step that has never worked live.
  const live = s.includes("proven (live");
  const fork = s.includes("proven (fork");
  // Blocked wins over proven when a status says both, as in "Proven (live) on
  // staging, blocked by gate for Railway". A green badge there would claim
  // something the public cannot check yet; the status text below the badge
  // still carries the whole sentence.
  if (s.includes("blocked")) return "blocked";
  if (live && fork) return "proven-mixed";
  if (fork) return "proven-fork";
  if (live) return "proven-live";
  if (s.includes("missing")) return "missing";
  if (s.includes("unproven") || s.includes("never proven") || s.includes("not established")) return "unproven";
  // qa also writes a verdict rather than a status word when a PR closed the
  // gap, for example "Fixed in SDK PR #103, verified live".
  if (s.includes("verified live") || s.includes("agent live")) return "proven-live";
  if (s.includes("proven")) return "proven-live";
  // Anything else keeps its words and is rendered as written, so a status the
  // matrix introduces later shows up in the view rather than disappearing.
  return "other";
}

/** Every markdown link in a cell, plus bare https URLs. */
function linksIn(cell) {
  const out = [];
  const md = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = md.exec(cell))) out.push({ label: m[1].replace(/`/g, ""), url: m[2] });
  return out;
}

/** Markdown emphasis and code ticks removed; the view styles its own text. */
function plain(cell) {
  return cell
    .replace(/\[([^\]]+)\]\((?:https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

const sections = [];
let current;
for (const line of text.split("\n")) {
  const heading = /^##\s+(.*)$/.exec(line);
  if (heading) {
    current = { title: heading[1].trim(), rows: [] };
    sections.push(current);
    continue;
  }
  if (!current || !line.trim().startsWith("|")) continue;
  const cells = splitRow(line);
  // The matrix's item tables are: # | Item | Status | Relay | Evidence.
  if (cells.length < 5) continue;
  // Header and separator rows of the matrix's own tables.
  if (/^#$/.test(cells[0]) || /^step$/i.test(cells[0])) continue;
  if (/^:?-+:?$/.test(cells[1] ?? "")) continue;

  const [item, title, status, relay, note] = cells;
  current.rows.push({
    item: plain(item),
    title: plain(title),
    status: plain(status),
    state: classify(status),
    relay: plain(relay) === "-" || plain(relay) === "—" ? "" : plain(relay),
    note: plain(note),
    links: linksIn(note),
  });
}

const updated = /Last updated:\s*([0-9-]+)/.exec(text)?.[1];
const withRows = sections.filter((s) => s.rows.length > 0);

const proof = {
  generatedAt: new Date().toISOString(),
  source: "celo-harness/MATRIX.md",
  ...(updated ? { matrixUpdated: updated } : {}),
  sections: withRows,
};

writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`);

const counts = {};
for (const s of withRows) for (const r of s.rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
console.log(`build-proof: ${withRows.length} sections, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
console.log(`wrote ${outPath}`);
