/**
 * `altana-mcp install`: one command that makes the gate's plumbing exist.
 *
 * Two halves that are easy to confuse:
 *
 *   Chrome needs a native messaging host manifest, a JSON file in a directory it
 *   reads at startup, naming an absolute executable path and the one extension
 *   allowed to connect.
 *
 *   The agent needs the MCP registered, which for Claude Code means a line in
 *   its user config, and for Claude Desktop and Cursor means an entry in a JSON
 *   file each.
 *
 * Both point at a launcher script rather than at `bun` with arguments, for two
 * different reasons that happen to have the same fix:
 *
 *   A native messaging manifest has a `path` and no args field, so whatever
 *   Chrome runs has to already know it is the host. That is why there are two
 *   launchers and not one.
 *
 *   Chrome does not give a native host the user's shell PATH, so a launcher that
 *   said `bun` would not find it. Every launcher sets PATH and execs bun by
 *   absolute path. Confirmed by hand before this was written, in
 *   `evidence/2026-10-28-keychain-acl.md` (run 2).
 *
 * Everything here is additive and reversible. An install touches only the
 * `altana` entry in a config it shares with other servers, and `uninstall`
 * removes only what install wrote.
 */

import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { redactedMessage } from "./redact.js";

const exec = promisify(execFile);

/** The host name in the contract. Chrome matches the manifest filename to it. */
export const HOST_NAME = "network.altana.mcp";

/** What the MCP is called in an agent's config. */
export const SERVER_NAME = "altana";

export type ClientName = "claude-code" | "claude-desktop" | "cursor";
const ALL_CLIENTS: ClientName[] = ["claude-code", "claude-desktop", "cursor"];

const EXTENSION_ID = /^[a-p]{32}$/;

// ---------- paths -----------------------------------------------------------

/** Where the launcher scripts go. Inside ALTANA_HOME, so one place holds it all. */
export function binDir(home = altanaHomeDir()): string {
  return join(home, "bin");
}

function altanaHomeDir(): string {
  const override = process.env.ALTANA_HOME?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".altana");
}

export function serverLauncherPath(home = altanaHomeDir()): string {
  return join(binDir(home), "altana-mcp-server");
}

export function hostLauncherPath(home = altanaHomeDir()): string {
  return join(binDir(home), "altana-mcp-native-host");
}

/**
 * The browsers an install writes a manifest for.
 *
 * Chrome is the one the gate needs and is always written, directory created if
 * missing, because Chrome reads this directory at startup and a first install
 * on a fresh profile has to work. The others are written only when their
 * profile directory already exists, so an install does not conjure a
 * configuration directory for a browser nobody has.
 */
export function browserManifestDirs(home = homedir()): { name: string; dir: string; always: boolean }[] {
  const support = join(home, "Library", "Application Support");
  return [
    { name: "Chrome", dir: join(support, "Google", "Chrome", "NativeMessagingHosts"), always: true },
    { name: "Chrome Beta", dir: join(support, "Google", "Chrome Beta", "NativeMessagingHosts"), always: false },
    { name: "Chrome Canary", dir: join(support, "Google", "Chrome Canary", "NativeMessagingHosts"), always: false },
    { name: "Chromium", dir: join(support, "Chromium", "NativeMessagingHosts"), always: false },
  ];
}

export function claudeDesktopConfigPath(home = homedir()): string {
  return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

export function cursorConfigPath(home = homedir()): string {
  return join(home, ".cursor", "mcp.json");
}

export function claudeCodeConfigPath(home = homedir()): string {
  return join(home, ".claude.json");
}

/** This package's CLI, as an absolute path, resolved from this file. */
export function cliEntryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");
}

// ---------- pure builders ---------------------------------------------------

/**
 * A launcher script.
 *
 * `exec` so the launcher does not sit in the process tree between Chrome and
 * the host: Chrome kills the process it started when the port closes, and a
 * shell parent would leave the real host orphaned.
 *
 * PATH is set rather than appended. Chrome hands a native host a near empty
 * environment, and inheriting whatever is there is how this works on one
 * machine and not the next.
 */
export function launcherScript(args: { bun: string; entry: string; argv?: string[] }): string {
  const extra = (args.argv ?? []).map((a) => ` ${shellQuote(a)}`).join("");
  return `#!/bin/sh
# Written by \`altana-mcp install\`. Edits here are lost on the next install.
#
# Chrome does not pass the user's shell PATH to a native messaging host, and a
# manifest cannot carry arguments, so both of those live in this file.
PATH="${dirname(args.bun)}:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
exec ${shellQuote(args.bun)} run ${shellQuote(args.entry)}${extra} "$@"
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type HostManifest = {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
};

/** The manifest, exactly as `packages/contracts/native-messaging.md` spells it. */
export function hostManifest(args: { path: string; extensionId: string }): HostManifest {
  return {
    name: HOST_NAME,
    description: "Altana MCP host",
    path: args.path,
    type: "stdio",
    allowed_origins: [`chrome-extension://${args.extensionId}/`],
  };
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/**
 * The extension id, from the flag or the environment, validated.
 *
 * Never defaulted or guessed. A wrong `allowed_origins` does not produce an
 * error anywhere: Chrome simply refuses the connection, the extension sees a
 * port that closes, and the hour that costs is the reason this throws instead.
 */
export function resolveExtensionId(flag?: string): string {
  const id = (flag ?? process.env.ALTANA_EXTENSION_ID ?? "").trim();
  if (!id) {
    throw new InstallError(
      "I need the Chrome extension id, with --extension-id or ALTANA_EXTENSION_ID. " +
        "The dev id for this gate is in packages/contracts/extension-id.txt in the " +
        "altana-extension repo. It is not guessed, because a wrong id shows up only " +
        "as a port that will not open.",
    );
  }
  if (!EXTENSION_ID.test(id)) {
    throw new InstallError(
      `"${id}" is not a Chrome extension id. One is 32 characters, each from a to p.`,
    );
  }
  return id;
}

/** Where bun is, as an absolute path. */
export async function resolveBun(explicit?: string): Promise<string> {
  const candidates = [
    explicit,
    // Under bun, this is bun itself, which is the one answer that cannot be
    // wrong about the interpreter that is going to run.
    process.versions.bun ? process.execPath : undefined,
    join(homedir(), ".bun", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new InstallError(
    "I could not find an executable bun. Pass --bun <path>. Chrome runs the host " +
      "without your shell PATH, so the launcher has to name bun by absolute path.",
  );
}

// ---------- what we replaced ------------------------------------------------

/**
 * Where install remembers an `altana` entry that was already there.
 *
 * An install has to be able to put somebody's configuration back. These files
 * are shared with other servers and may already hold an `altana` entry pointing
 * at a published build; replacing it with a dev launcher and then uninstalling
 * would leave them with neither.
 */
export function backupPath(home = altanaHomeDir()): string {
  return join(home, "install-backup.json");
}

type Backup = {
  v: 1;
  /** Keyed by config path. null means there was genuinely no entry before. */
  replaced: Record<string, { name: string; previous: unknown; replacedAt: string }>;
};

async function readBackup(): Promise<Backup> {
  const parsed = await readJsonObject(backupPath()).catch(() => ({}) as Record<string, unknown>);
  const replaced = isRecord(parsed.replaced) ? parsed.replaced : {};
  return { v: 1, replaced: replaced as Backup["replaced"] };
}

/**
 * Record what was at `name` in that config before we touched it.
 *
 * Only the first time. A second install would otherwise record our own dev
 * entry as the thing to restore, which is exactly the configuration the person
 * wanted undone, and the real previous value would be lost for good.
 */
async function rememberReplaced(args: {
  path: string;
  name: string;
  previous: unknown;
  dryRun?: boolean;
}): Promise<void> {
  const backup = await readBackup();
  if (args.path in backup.replaced) return;
  backup.replaced[args.path] = {
    name: args.name,
    previous: args.previous ?? null,
    replacedAt: new Date().toISOString(),
  };
  if (!args.dryRun) {
    await writeFileAtomic(backupPath(), `${JSON.stringify(backup, null, 2)}\n`, 0o600);
  }
}

/** What was replaced at that config, if anything was. */
export async function replacedEntry(path: string): Promise<unknown | undefined> {
  const backup = await readBackup();
  return path in backup.replaced ? backup.replaced[path]?.previous : undefined;
}

/** How many replaced entries are still waiting to be put back. */
export async function replacedEntryCount(): Promise<number> {
  return Object.keys((await readBackup()).replaced).length;
}

async function forgetReplaced(path: string, dryRun?: boolean): Promise<void> {
  const backup = await readBackup();
  if (!(path in backup.replaced)) return;
  delete backup.replaced[path];
  if (!dryRun) {
    await writeFileAtomic(backupPath(), `${JSON.stringify(backup, null, 2)}\n`, 0o600);
  }
}

/** A one line description of an MCP entry, for telling somebody what changed. */
export function describeEntry(entry: unknown): string {
  if (!isRecord(entry)) return "something this installer does not recognise";
  const command = typeof entry.command === "string" ? entry.command : undefined;
  const url = typeof entry.url === "string" ? entry.url : undefined;
  return command ?? url ?? "an entry with neither a command nor a url";
}

/**
 * Is ALTANA_HOME inside the system temp directory?
 *
 * A test run points ALTANA_HOME at a temp directory on purpose. An install from
 * inside one then writes a real Chrome manifest, in the real Chrome directory,
 * naming a launcher that will be deleted, and nothing says so until the port
 * will not open. QA hit exactly that
 * (`evidence/2026-10-28-g1-install-home-trap.md`), so it gets said out loud.
 */
export function homeIsTemporary(home = altanaHomeDir()): boolean {
  const temp = resolve(tmpdir());
  const resolved = resolve(home);
  return resolved === temp || resolved.startsWith(`${temp}/`) || resolved.startsWith("/private/tmp/") || resolved.startsWith("/tmp/");
}

// ---------- writing ---------------------------------------------------------

export type Step = { did: string; path?: string };

async function writeFileAtomic(path: string, body: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
}

export async function writeLaunchers(args: {
  bun: string;
  entry: string;
  home?: string;
  dryRun?: boolean;
}): Promise<Step[]> {
  const home = args.home ?? altanaHomeDir();
  const planned: { path: string; body: string }[] = [
    { path: serverLauncherPath(home), body: launcherScript({ bun: args.bun, entry: args.entry }) },
    {
      path: hostLauncherPath(home),
      body: launcherScript({ bun: args.bun, entry: args.entry, argv: ["native-host"] }),
    },
  ];
  const steps: Step[] = [];
  for (const { path, body } of planned) {
    if (!args.dryRun) await writeFileAtomic(path, body, 0o700);
    steps.push({ did: "launcher", path });
  }
  return steps;
}

export async function writeHostManifests(args: {
  extensionId: string;
  hostLauncher: string;
  home?: string;
  dryRun?: boolean;
}): Promise<Step[]> {
  const manifest = hostManifest({ path: args.hostLauncher, extensionId: args.extensionId });
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const steps: Step[] = [];
  for (const browser of browserManifestDirs(args.home)) {
    if (!browser.always && !(await exists(browser.dir))) continue;
    const path = join(browser.dir, `${HOST_NAME}.json`);
    if (!args.dryRun) await writeFileAtomic(path, body, 0o600);
    steps.push({ did: `manifest for ${browser.name}`, path });
  }
  return steps;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add or replace one key in a JSON config's `mcpServers`, leaving every other
 * key and every other top-level field exactly as it was.
 *
 * These files belong to the user and hold other people's servers. Rewriting one
 * wholesale, or reformatting it, is the kind of thing that loses somebody's
 * configuration and is never traced back here.
 */
export async function upsertMcpServer(args: {
  path: string;
  name: string;
  entry: unknown;
  dryRun?: boolean;
}): Promise<{ how: "added" | "replaced" | "unchanged"; previous?: unknown }> {
  const config = await readJsonObject(args.path);
  const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
  const existed = args.name in servers;
  const previous = existed ? servers[args.name] : undefined;

  if (existed && JSON.stringify(previous) === JSON.stringify(args.entry)) {
    return { how: "unchanged" };
  }
  // Remembered before the write, and only ever the first value, so uninstall
  // can put back what was really there rather than our own dev entry.
  if (existed) {
    await rememberReplaced({ path: args.path, name: args.name, previous, dryRun: args.dryRun });
  }

  servers[args.name] = args.entry;
  if (!args.dryRun) {
    await writeFileAtomic(args.path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, 0o600);
  }
  return existed ? { how: "replaced", previous } : { how: "added" };
}

export async function removeMcpServer(args: {
  path: string;
  name: string;
  dryRun?: boolean;
}): Promise<{ how: "removed" | "restored"; previous?: unknown } | false> {
  if (!(await exists(args.path))) return false;
  const config = await readJsonObject(args.path);
  if (!isRecord(config.mcpServers) || !(args.name in config.mcpServers)) {
    // Nothing of ours to take out, but a remembered entry still has to go back:
    // somebody may have deleted our entry by hand after an install.
    const remembered = await replacedEntry(args.path);
    if (remembered === undefined || remembered === null) return false;
    const base = isRecord(config.mcpServers) ? config.mcpServers : {};
    const servers = { ...base, [args.name]: remembered };
    if (!args.dryRun) {
      await writeFileAtomic(args.path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, 0o600);
      await forgetReplaced(args.path);
    }
    return { how: "restored", previous: remembered };
  }

  const servers = { ...config.mcpServers };
  const remembered = await replacedEntry(args.path);
  // Uninstall means "leave this machine as it was", which is a restore when
  // there was something here before and a delete when there was not.
  if (remembered !== undefined && remembered !== null) {
    servers[args.name] = remembered;
  } else {
    delete servers[args.name];
  }
  if (!args.dryRun) {
    await writeFileAtomic(args.path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, 0o600);
    await forgetReplaced(args.path);
  }
  return remembered !== undefined && remembered !== null
    ? { how: "restored", previous: remembered }
    : { how: "removed" };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Refusing beats overwriting. A config that does not parse is somebody's
    // file with a typo in it, and replacing it with ours loses their servers.
    throw new InstallError(
      `${path} is not valid JSON, so I will not rewrite it: ${redactedMessage(err)}`,
    );
  }
  return isRecord(parsed) ? { ...parsed } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stdio entry an agent config needs to start the MCP. */
export function mcpServerEntry(launcher: string): { type: "stdio"; command: string; args: string[] } {
  return { type: "stdio", command: launcher, args: [] };
}

/**
 * Register with Claude Code.
 *
 * The CLI first, because it owns the file and knows its current shape, then a
 * direct edit when the CLI is missing or refuses. That is the pattern in
 * altana-desktop/src/main/mcp/register.ts, and the fallback matters here: on
 * this Mac `claude` resolves to a temporary shim directory, so the CLI is not
 * something to depend on.
 */
export async function registerClaudeCode(args: {
  launcher: string;
  home?: string;
  dryRun?: boolean;
}): Promise<Step> {
  const path = claudeCodeConfigPath(args.home);
  if (args.dryRun) return { did: "Claude Code (dry run)", path };

  // Read before the CLI gets a chance to write, because `claude mcp add` goes
  // around upsertMcpServer and would take an existing entry with it.
  const before = await readJsonObject(path).catch(() => ({}) as Record<string, unknown>);
  const existing = isRecord(before.mcpServers) ? before.mcpServers[SERVER_NAME] : undefined;

  try {
    await exec("claude", ["mcp", "add", "-s", "user", SERVER_NAME, "--", args.launcher], {
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin` },
    });
    if (existing !== undefined) {
      await rememberReplaced({ path, name: SERVER_NAME, previous: existing });
      return {
        did: `Claude Code, through its CLI, replacing ${describeEntry(existing)}`,
        path,
      };
    }
    return { did: "Claude Code, through its CLI" };
  } catch {
    const { how, previous } = await upsertMcpServer({
      path,
      name: SERVER_NAME,
      entry: mcpServerEntry(args.launcher),
    });
    const note = how === "replaced" ? `${how}, was ${describeEntry(previous)}` : how;
    return { did: `Claude Code, by editing its config (${note})`, path };
  }
}

export async function runInstallCli(command: "install" | "uninstall", argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`altana-mcp ${command}: ${redactedMessage(err)}\n`);
    return 2;
  }

  try {
    const steps =
      command === "install" ? await install(parsed) : await uninstall(parsed);
    for (const step of steps) {
      process.stderr.write(`  ${step.did}${step.path ? `: ${step.path}` : ""}\n`);
    }
    process.stderr.write(
      parsed.dryRun
        ? `\naltana-mcp ${command}: dry run, nothing was written.\n`
        : `\naltana-mcp ${command}: done.\n`,
    );
    if (command === "install" && !parsed.dryRun) {
      process.stderr.write(
        "Chrome reads host manifests when it starts, so restart Chrome before connecting.\n",
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`altana-mcp ${command}: ${redactedMessage(err)}\n`);
    return 1;
  }
}

type Parsed = {
  extensionId?: string;
  clients: ClientName[];
  bun?: string;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { clients: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new InstallError(`${arg} needs a value after it.`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--extension-id":
        out.extensionId = next();
        break;
      case "--bun":
        out.bun = next();
        break;
      case "--client": {
        const value = next();
        if (!ALL_CLIENTS.includes(value as ClientName)) {
          throw new InstallError(
            `--client takes one of ${ALL_CLIENTS.join(", ")}, not "${value}".`,
          );
        }
        out.clients.push(value as ClientName);
        break;
      }
      case "--dry-run":
        out.dryRun = true;
        break;
      default:
        throw new InstallError(`no option called ${arg}.`);
    }
  }
  return out;
}

async function install(parsed: Parsed): Promise<Step[]> {
  const extensionId = resolveExtensionId(parsed.extensionId);
  const bun = await resolveBun(parsed.bun);
  const entry = cliEntryPath();
  const steps: Step[] = [];

  // Said before anything is written, because the thing that goes wrong here is
  // a real Chrome manifest naming a launcher inside a directory that is about
  // to be deleted, and nothing complains until the port will not open.
  if (homeIsTemporary()) {
    steps.push({
      did:
        "warning: ALTANA_HOME is inside the system temp directory, so the launcher " +
        "this writes will disappear when that directory is cleaned up, while the " +
        "Chrome manifest naming it stays in the real Chrome directory. If this is a " +
        "test run, point the manifest somewhere else or run uninstall afterwards",
      path: altanaHomeDir(),
    });
  }

  steps.push(
    ...(await writeLaunchers({ bun, entry, dryRun: parsed.dryRun })),
    ...(await writeHostManifests({
      extensionId,
      hostLauncher: hostLauncherPath(),
      dryRun: parsed.dryRun,
    })),
  );

  const wanted = parsed.clients.length > 0 ? parsed.clients : ALL_CLIENTS;
  const launcher = serverLauncherPath();

  for (const client of wanted) {
    if (client === "claude-code") {
      steps.push(await registerClaudeCode({ launcher, dryRun: parsed.dryRun }));
      continue;
    }
    const path = client === "claude-desktop" ? claudeDesktopConfigPath() : cursorConfigPath();
    // An explicit --client is a request, so it is honoured even if the app has
    // never been run. Without one, only what is already installed is touched.
    const asked = parsed.clients.length > 0;
    if (!asked && !(await exists(dirname(path)))) {
      steps.push({ did: `${client}: not installed, skipped` });
      continue;
    }
    const { how, previous } = await upsertMcpServer({
      path,
      name: SERVER_NAME,
      entry: mcpServerEntry(launcher),
      dryRun: parsed.dryRun,
    });
    // Saying what was there is the point: an entry silently swapped for a dev
    // launcher is the kind of thing somebody finds out about a week later.
    steps.push({
      did:
        how === "replaced"
          ? `${client} (replaced ${describeEntry(previous)}, kept in ${backupPath()} for uninstall)`
          : `${client} (${how})`,
      path,
    });
  }
  return steps;
}

async function uninstall(parsed: Parsed): Promise<Step[]> {
  const steps: Step[] = [];
  for (const browser of browserManifestDirs()) {
    const path = join(browser.dir, `${HOST_NAME}.json`);
    if (!(await exists(path))) continue;
    if (!parsed.dryRun) await unlink(path).catch(() => {});
    steps.push({ did: `removed the manifest for ${browser.name}`, path });
  }
  for (const path of [serverLauncherPath(), hostLauncherPath()]) {
    if (!(await exists(path))) continue;
    if (!parsed.dryRun) await unlink(path).catch(() => {});
    steps.push({ did: "removed a launcher", path });
  }
  for (const path of [claudeCodeConfigPath(), claudeDesktopConfigPath(), cursorConfigPath()]) {
    const result = await removeMcpServer({ path, name: SERVER_NAME, dryRun: parsed.dryRun });
    if (!result) continue;
    steps.push({
      did:
        result.how === "restored"
          ? `put back the ${SERVER_NAME} entry that was here before: ${describeEntry(result.previous)}`
          : `removed the ${SERVER_NAME} entry`,
      path,
    });
  }
  // Only once every config has been dealt with, so a failure part way through
  // does not throw away what is still needed to put things back.
  if (!parsed.dryRun && (await exists(backupPath()))) {
    const left = await replacedEntryCount();
    if (left === 0) {
      await unlink(backupPath()).catch(() => {});
      steps.push({ did: "removed the record of what was replaced", path: backupPath() });
    }
  }
  if (steps.length === 0) steps.push({ did: "nothing of ours was installed" });
  return steps;
}
