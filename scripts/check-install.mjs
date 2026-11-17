// Install check: pack every publishable package the way npm receives it,
// install the tarballs into an empty project, and prove a consumer can use
// them.
//
// Why: nothing else in CI looks at the tarball. A `workspace:` dependency, a
// file missing from `files`, or a type that no longer accepts code written for
// the previous release all pass the workspace build and break the first
// install. The fixture in scripts/install-check/ is code written for 0.9.0; it
// must keep compiling against what we are about to publish.
//
// Run after building: `bun run build` for sdk and x402-server, then
// `node scripts/check-install.mjs`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgsDir = join(root, "packages");
const work = mkdtempSync(join(tmpdir(), "altana-install-check-"));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`✖ ${msg}`);
};

try {
  // 1. Pack. --ignore-scripts: the build already ran, and prepublishOnly is
  //    npm publish's business.
  const packed = [];
  for (const dir of readdirSync(pkgsDir)) {
    const pkgPath = join(pkgsDir, dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.private) continue;
    const out = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", work], join(pkgsDir, dir));
    const info = JSON.parse(out)[0];
    packed.push({ pkg, tarball: join(work, info.filename), files: info.files.map((f) => f.path) });
    console.log(`packed ${pkg.name}@${pkg.version} (${info.files.length} files)`);
  }

  // 2. What the tarball declares must be inside it.
  for (const { pkg, files } of packed) {
    const declared = [pkg.main, pkg.types, ...Object.values(pkg.bin ?? {})].filter(Boolean);
    for (const entry of Object.values(pkg.exports ?? {})) {
      if (typeof entry === "string") declared.push(entry);
      else declared.push(...Object.values(entry).filter((v) => typeof v === "string"));
    }
    for (const path of new Set(declared.map((p) => p.replace(/^\.\//, "")))) {
      if (!files.includes(path)) fail(`${pkg.name}: package.json points at ${path}, which is not in the tarball`);
    }
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        if (String(range).startsWith("workspace:")) fail(`${pkg.name}: ${field}.${dep} is "${range}"`);
      }
    }
  }

  // 3. Install all tarballs together into an empty project. Sibling packages
  //    resolve to each other's tarballs, so their ranges must accept the
  //    versions being released.
  const app = join(work, "app");
  cpSync(join(root, "scripts", "install-check"), app, { recursive: true });
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "install-check", private: true, type: "module" }, null, 2),
  );
  const ts = JSON.parse(readFileSync(join(root, "packages", "wallet", "package.json"), "utf8")).devDependencies
    ?.typescript;
  try {
    run("npm", ["install", "--no-audit", "--no-fund", ...packed.map((p) => p.tarball), `typescript@${ts ?? "latest"}`], app);
    console.log("installed every tarball into an empty project");
  } catch (err) {
    fail(`npm install of the tarballs failed:\n${err.stderr ?? err.message}`);
  }

  if (!failed) {
    // 4. The built packages load under plain Node.
    try {
      console.log(run("node", ["import.mjs"], app).trim());
    } catch (err) {
      fail(`importing the installed packages failed:\n${err.stderr ?? err.message}`);
    }
    // 5. Code written for the previous release still compiles.
    try {
      run(join(app, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], app);
      console.log("code written for 0.9.0 compiles against the installed packages");
    } catch (err) {
      fail(`code written for 0.9.0 no longer compiles:\n${err.stdout ?? err.message}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("✓ install check passed");
