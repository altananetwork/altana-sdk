// Pre-publish guard: fail if any publishable (non-private) workspace package
// ships an unresolved `workspace:` dependency.
//
// Why: npm publish does NOT rewrite the `workspace:` protocol (bun publish does).
// A published package with `"dep": "workspace:*"` breaks every consumer install
// with `EUNSUPPORTEDPROTOCOL`. This bit @altananetwork/mcp@0.2.1. Pin a real
// semver range instead (it still links the local workspace package in the
// monorepo). See memory: sdk-publish-workspace-gotcha.
//
// Runs from each publishable package's `prepublishOnly`, so it fires on both
// `npm publish` and `bun publish` regardless of which one is used.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgsDir = join(root, "packages");

const DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const problems = [];

for (const name of readdirSync(pkgsDir)) {
  const pkgJsonPath = join(pkgsDir, name, "package.json");
  if (!existsSync(pkgJsonPath) || !statSync(join(pkgsDir, name)).isDirectory()) {
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (pkg.private) continue; // private packages are never published

  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        problems.push(
          `  ${pkg.name} → ${field}.${dep} = "${range}"  (pin a real range, e.g. "^x.y.z")`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(
    "\n✖ Refusing to publish: unresolved workspace: dependencies found.\n" +
      "  npm publish won't rewrite these and consumers' installs will fail\n" +
      "  with EUNSUPPORTEDPROTOCOL. Replace with a real semver range.\n\n" +
      problems.join("\n") +
      "\n",
  );
  process.exit(1);
}

// --- EIP-55 checksum guard ---
// A mis-cased address literal makes viem throw at runtime (readContract /
// getKeys), which shipped in @altananetwork/sdk@0.3.2 and broke grantSession.
// Scan every publishable package's source/dist for 40-hex address literals and
// reject any that fails its checksum. EIP-55 rule (what viem enforces): an
// all-lowercase or all-uppercase address is fine, but a MIXED-case address must
// equal its checksum form. getAddress() normalizes rather than throws, so we
// compare against it ourselves for the mixed-case case.
const ADDR_RE = /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const SCAN_EXT = /\.(ts|mjs|cjs|js|json)$/;
const badAddrs = [];

function isBadChecksum(addr) {
  const body = addr.slice(2);
  const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
  if (!mixed) return false; // all-lower / all-upper are valid unchecksummed forms
  try {
    return getAddress(addr) !== addr; // mixed-case must match its checksum
  } catch {
    return true;
  }
}

function scanForAddresses(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForAddresses(p);
    } else if (SCAN_EXT.test(entry.name)) {
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(ADDR_RE)) {
        if (isBadChecksum(m[0])) badAddrs.push(`  ${p}: ${m[0]}`);
      }
    }
  }
}

for (const name of readdirSync(pkgsDir)) {
  const dir = join(pkgsDir, name);
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath) || !statSync(dir).isDirectory()) continue;
  if (JSON.parse(readFileSync(pkgJsonPath, "utf8")).private) continue;
  scanForAddresses(dir);
}

if (badAddrs.length > 0) {
  console.error(
    "\n✖ Refusing to publish: address literal(s) with an invalid EIP-55 checksum.\n" +
      "  viem rejects mis-cased addresses at runtime (readContract/getKeys), so\n" +
      "  these would break consumers. Fix the casing: `cast to-check-sum-address <addr>`.\n\n" +
      badAddrs.join("\n") +
      "\n",
  );
  process.exit(1);
}

console.log(
  "✔ publishable packages clean — no workspace: deps, all address checksums valid.",
);
