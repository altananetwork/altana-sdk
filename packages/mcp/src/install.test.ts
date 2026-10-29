import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  backupPath,
  browserManifestDirs,
  claudeDesktopConfigPath,
  cliEntryPath,
  cursorConfigPath,
  describeEntry,
  homeIsTemporary,
  hostLauncherPath,
  hostManifest,
  HOST_NAME,
  InstallError,
  launcherScript,
  mcpServerEntry,
  parseArgs,
  removeMcpServer,
  replacedEntry,
  resolveBun,
  resolveExtensionId,
  serverLauncherPath,
  upsertMcpServer,
  writeHostManifests,
  writeLaunchers,
  SERVER_NAME,
} from "./install.js";

/** A real looking extension id: 32 characters, each from a to p. */
const ID = "abcdefghijklmnopabcdefghijklmnop";

let home: string;
const realAltanaHome = process.env.ALTANA_HOME;
const realEnvId = process.env.ALTANA_EXTENSION_ID;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-install-"));
  process.env.ALTANA_HOME = join(home, ".altana");
  delete process.env.ALTANA_EXTENSION_ID;
});

afterEach(async () => {
  if (realAltanaHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realAltanaHome;
  if (realEnvId === undefined) delete process.env.ALTANA_EXTENSION_ID;
  else process.env.ALTANA_EXTENSION_ID = realEnvId;
  await rm(home, { recursive: true, force: true });
});

describe("resolveExtensionId", () => {
  test("takes the flag", () => {
    expect(resolveExtensionId(ID)).toBe(ID);
  });

  test("falls back to the environment", () => {
    process.env.ALTANA_EXTENSION_ID = ID;
    expect(resolveExtensionId()).toBe(ID);
  });

  test("refuses to guess when there is none", () => {
    // A wrong allowed_origins is a port that will not open and no error
    // anywhere, so a default here would cost an hour of looking in Chrome.
    expect(() => resolveExtensionId()).toThrow(InstallError);
    expect(() => resolveExtensionId()).toThrow(/extension-id.txt/);
  });

  test("refuses something that is not an extension id", () => {
    expect(() => resolveExtensionId("nope")).toThrow(/32 characters/);
    // Extension ids use a to p only, so hex digits past p are a giveaway.
    expect(() => resolveExtensionId("z".repeat(32))).toThrow(InstallError);
  });
});

describe("launcherScript", () => {
  test("sets PATH and execs bun by absolute path", () => {
    // Chrome gives a native host no shell PATH, so a bare bun would not
    // resolve. Proven by hand in evidence/2026-10-28-keychain-acl.md, run 2.
    const script = launcherScript({ bun: "/Users/x/.bun/bin/bun", entry: "/pkg/src/cli.ts" });
    expect(script.startsWith("#!/bin/sh")).toBe(true);
    expect(script).toContain(`PATH="/Users/x/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"`);
    expect(script).toContain(`exec '/Users/x/.bun/bin/bun' run '/pkg/src/cli.ts'`);
  });

  test("execs rather than runs, so Chrome's kill reaches the host", () => {
    // A shell sitting between Chrome and the host would leave the real host
    // orphaned when the port closes.
    expect(launcherScript({ bun: "/b/bun", entry: "/e.ts" })).toMatch(/^exec /m);
  });

  test("the host launcher carries the subcommand, because a manifest cannot", () => {
    const script = launcherScript({ bun: "/b/bun", entry: "/e.ts", argv: ["native-host"] });
    expect(script).toContain(`run '/e.ts' 'native-host' "$@"`);
  });

  test("the host launcher moves the protocol off fd 1, and tells the host where it went", () => {
    // Chrome closes the port the instant it reads a length prefix it cannot
    // believe, so anything the runtime or a library prints to stdout lands in
    // the middle of a frame and is indistinguishable from a host that answered
    // nothing. Moving stdout to fd 3 and pointing fd 1 at stderr removes the
    // whole class.
    const script = launcherScript({
      bun: "/b/bun",
      entry: "/e.ts",
      argv: ["native-host"],
      protectStdout: true,
    });
    expect(script).toContain("exec 3>&1 1>&2");
    expect(script).toContain(`'--frames-fd' '3'`);
    // The redirection has to come before the exec that replaces the shell.
    expect(script.indexOf("exec 3>&1")).toBeLessThan(script.indexOf("exec '/b/bun'"));
  });

  test("the server launcher leaves stdout alone, because that is its JSON-RPC channel", () => {
    const script = launcherScript({ bun: "/b/bun", entry: "/e.ts" });
    expect(script).not.toContain("3>&1");
    expect(script).not.toContain("--frames-fd");
  });

  test("quotes a path with a space in it", () => {
    const script = launcherScript({ bun: "/opt/my bun/bun", entry: "/a b/cli.ts" });
    expect(script).toContain(`exec '/opt/my bun/bun' run '/a b/cli.ts'`);
  });
});

describe("hostManifest", () => {
  test("is exactly the shape the contract spells out", () => {
    expect(hostManifest({ path: "/abs/launcher", extensionId: ID })).toEqual({
      name: "network.altana.mcp",
      description: "Altana MCP host",
      path: "/abs/launcher",
      type: "stdio",
      allowed_origins: [`chrome-extension://${ID}/`],
    });
  });

  test("the origin keeps its trailing slash, which Chrome matches on", () => {
    expect(hostManifest({ path: "/x", extensionId: ID }).allowed_origins[0]).toBe(
      `chrome-extension://${ID}/`,
    );
  });
});

describe("writeLaunchers", () => {
  test("writes both launchers executable, at 0700", async () => {
    const steps = await writeLaunchers({ bun: "/b/bun", entry: cliEntryPath() });
    expect(steps).toHaveLength(2);
    for (const path of [serverLauncherPath(), hostLauncherPath()]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    const host = await readFile(hostLauncherPath(), "utf8");
    expect(host).toContain("'native-host'");
    // What install actually writes is the protected form, since this is the
    // launcher Chrome runs.
    expect(host).toContain("exec 3>&1 1>&2");
    expect(host).toContain(`'--frames-fd' '3'`);
    expect(await readFile(serverLauncherPath(), "utf8")).not.toContain("'native-host'");
  });

  test("a dry run writes nothing but still reports what it would do", async () => {
    const steps = await writeLaunchers({ bun: "/b/bun", entry: "/e.ts", dryRun: true });
    expect(steps).toHaveLength(2);
    await expect(stat(serverLauncherPath())).rejects.toThrow();
  });

  test("installing twice is idempotent", async () => {
    await writeLaunchers({ bun: "/b/bun", entry: "/e.ts" });
    const first = await readFile(hostLauncherPath(), "utf8");
    await writeLaunchers({ bun: "/b/bun", entry: "/e.ts" });
    expect(await readFile(hostLauncherPath(), "utf8")).toBe(first);
  });
});

describe("writeHostManifests", () => {
  test("always writes Chrome, creating the directory on a fresh profile", async () => {
    const steps = await writeHostManifests({ extensionId: ID, hostLauncher: "/abs/host", home });
    const chrome = browserManifestDirs(home).find((b) => b.name === "Chrome")!;
    const path = join(chrome.dir, `${HOST_NAME}.json`);
    expect(steps.some((s) => s.path === path)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
      hostManifest({ path: "/abs/host", extensionId: ID }),
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("skips a browser that is not installed, and writes one that is", async () => {
    // No configuration directory is conjured for a browser nobody has.
    const chromium = browserManifestDirs(home).find((b) => b.name === "Chromium")!;
    let steps = await writeHostManifests({ extensionId: ID, hostLauncher: "/abs/host", home });
    expect(steps.some((s) => s.did.includes("Chromium"))).toBe(false);

    await mkdir(chromium.dir, { recursive: true });
    steps = await writeHostManifests({ extensionId: ID, hostLauncher: "/abs/host", home });
    expect(steps.some((s) => s.did.includes("Chromium"))).toBe(true);
  });
});

describe("upsertMcpServer", () => {
  test("adds our entry and leaves every other server alone", async () => {
    // These files hold other people's servers. Losing one would never be
    // traced back here.
    const path = join(home, "config.json");
    await writeFile(
      path,
      JSON.stringify({ somethingElse: true, mcpServers: { theirs: { type: "http", url: "https://x" } } }),
    );
    expect(await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/abs/launcher") })).toEqual({
      how: "added",
    });

    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.somethingElse).toBe(true);
    expect(after.mcpServers.theirs).toEqual({ type: "http", url: "https://x" });
    expect(after.mcpServers[SERVER_NAME]).toEqual({ type: "stdio", command: "/abs/launcher", args: [] });
  });

  test("a second install replaces our entry rather than duplicating it", async () => {
    const path = join(home, "config.json");
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/one") });
    const second = await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/two") });
    expect(second.how).toBe("replaced");
    expect(second.previous).toEqual(mcpServerEntry("/one"));
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.mcpServers[SERVER_NAME].command).toBe("/two");
  });

  test("a missing file is created with just our entry", async () => {
    const path = join(home, "nested", "config.json");
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/abs") });
    expect(Object.keys(JSON.parse(await readFile(path, "utf8")).mcpServers)).toEqual([SERVER_NAME]);
  });

  test("an empty file is treated as an empty config, not as broken", async () => {
    const path = join(home, "empty.json");
    await writeFile(path, "   ");
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/abs") });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers[SERVER_NAME]).toBeDefined();
  });

  test("refuses a config that does not parse instead of overwriting it", async () => {
    const path = join(home, "broken.json");
    await writeFile(path, "{ this is someone's file with a typo");
    await expect(
      upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/abs") }),
    ).rejects.toThrow(InstallError);
    // Still theirs, untouched.
    expect(await readFile(path, "utf8")).toContain("someone's file");
  });
});

describe("removeMcpServer", () => {
  test("removes only our entry", async () => {
    const path = join(home, "config.json");
    await writeFile(path, JSON.stringify({ mcpServers: { theirs: { url: "https://x" } } }));
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/abs") });

    expect(await removeMcpServer({ path, name: SERVER_NAME })).toEqual({ how: "removed" });
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.mcpServers.theirs).toEqual({ url: "https://x" });
    expect(after.mcpServers[SERVER_NAME]).toBeUndefined();
  });

  test("says false when there was nothing of ours, and when there is no file", async () => {
    const path = join(home, "config.json");
    await writeFile(path, JSON.stringify({ mcpServers: {} }));
    expect(await removeMcpServer({ path, name: SERVER_NAME })).toBe(false);
    expect(await removeMcpServer({ path: join(home, "nope.json"), name: SERVER_NAME })).toBe(false);
  });
});

describe("resolveBun", () => {
  test("finds the bun running this test", async () => {
    expect(await resolveBun()).toBe(process.execPath);
  });

  test("takes an explicit path when it is executable", async () => {
    expect(await resolveBun(process.execPath)).toBe(process.execPath);
  });

  test("falls through a path that is not executable rather than writing it into a launcher", async () => {
    const notExecutable = join(home, "not-bun");
    await writeFile(notExecutable, "", { mode: 0o600 });
    expect(await resolveBun(notExecutable)).toBe(process.execPath);
  });
});

describe("parseArgs", () => {
  test("reads the flags install takes", () => {
    expect(parseArgs(["--extension-id", ID, "--client", "cursor", "--dry-run"])).toEqual({
      extensionId: ID,
      clients: ["cursor"],
      dryRun: true,
    });
  });

  test("--client can be repeated", () => {
    expect(parseArgs(["--client", "claude-code", "--client", "cursor"]).clients).toEqual([
      "claude-code",
      "cursor",
    ]);
  });

  test("refuses an unknown option, a bad client and a flag with no value", () => {
    expect(() => parseArgs(["--nope"])).toThrow(InstallError);
    expect(() => parseArgs(["--client", "emacs"])).toThrow(/claude-code/);
    expect(() => parseArgs(["--extension-id"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--extension-id", "--dry-run"])).toThrow(/needs a value/);
  });
});

describe("the paths an install touches", () => {
  test("are the ones each client actually reads", () => {
    expect(claudeDesktopConfigPath("/h")).toBe(
      "/h/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(cursorConfigPath("/h")).toBe("/h/.cursor/mcp.json");
    expect(browserManifestDirs("/h").find((b) => b.name === "Chrome")?.dir).toBe(
      "/h/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    );
  });

  test("the launchers live inside ALTANA_HOME, so one directory holds it all", () => {
    expect(dirname(serverLauncherPath())).toBe(join(process.env.ALTANA_HOME!, "bin"));
  });

  test("the entry point is this package's cli.ts, as an absolute path", () => {
    expect(cliEntryPath().endsWith("/src/cli.ts")).toBe(true);
    expect(cliEntryPath().startsWith("/")).toBe(true);
  });
});

describe("keeping what was already there", () => {
  test("an existing altana entry is remembered, and uninstall puts it back", async () => {
    // The case QA raised: somebody already runs a published altana MCP, an
    // install points it at a dev launcher, and an uninstall would otherwise
    // leave them with neither.
    const path = join(home, "config.json");
    const theirs = { type: "stdio", command: "/usr/local/bin/altana-mcp", args: [] };
    await writeFile(path, JSON.stringify({ mcpServers: { [SERVER_NAME]: theirs } }));

    const first = await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/dev/launcher") });
    expect(first.how).toBe("replaced");
    expect(first.previous).toEqual(theirs);
    expect(await replacedEntry(path)).toEqual(theirs);

    expect(await removeMcpServer({ path, name: SERVER_NAME })).toEqual({ how: "restored", previous: theirs });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers[SERVER_NAME]).toEqual(theirs);
  });

  test("a second install does not overwrite the remembered entry with our own", async () => {
    // Otherwise the thing uninstall restores is the dev launcher the person
    // wanted undone, and the real previous value is gone for good.
    const path = join(home, "config.json");
    const theirs = { type: "stdio", command: "/usr/local/bin/altana-mcp", args: [] };
    await writeFile(path, JSON.stringify({ mcpServers: { [SERVER_NAME]: theirs } }));

    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/dev/one") });
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/dev/two") });
    expect(await replacedEntry(path)).toEqual(theirs);
  });

  test("an unchanged entry is reported as unchanged and remembers nothing", async () => {
    const path = join(home, "config.json");
    const ours = mcpServerEntry("/dev/launcher");
    await upsertMcpServer({ path, name: SERVER_NAME, entry: ours });
    expect(await upsertMcpServer({ path, name: SERVER_NAME, entry: ours })).toEqual({ how: "unchanged" });
    expect(await replacedEntry(path)).toBeUndefined();
  });

  test("with nothing there before, uninstall removes rather than restores", async () => {
    const path = join(home, "config.json");
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/dev/launcher") });
    expect(await removeMcpServer({ path, name: SERVER_NAME })).toEqual({ how: "removed" });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers[SERVER_NAME]).toBeUndefined();
  });

  test("a remembered entry goes back even if our entry was deleted by hand", async () => {
    const path = join(home, "config.json");
    const theirs = { type: "http", url: "https://mcp.altana.network" };
    await writeFile(path, JSON.stringify({ mcpServers: { [SERVER_NAME]: theirs } }));
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/dev/launcher") });

    await writeFile(path, JSON.stringify({ mcpServers: {} }));
    expect(await removeMcpServer({ path, name: SERVER_NAME })).toEqual({ how: "restored", previous: theirs });
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers[SERVER_NAME]).toEqual(theirs);
  });

  test("the record lives in ALTANA_HOME, so a test run keeps its own", () => {
    expect(backupPath()).toBe(join(process.env.ALTANA_HOME!, "install-backup.json"));
  });

  test("a dry run remembers nothing and changes nothing", async () => {
    const path = join(home, "config.json");
    const theirs = { type: "stdio", command: "/usr/local/bin/altana-mcp", args: [] };
    await writeFile(path, JSON.stringify({ mcpServers: { [SERVER_NAME]: theirs } }));
    await upsertMcpServer({ path, name: SERVER_NAME, entry: mcpServerEntry("/dev/x"), dryRun: true });
    expect(await replacedEntry(path)).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers[SERVER_NAME]).toEqual(theirs);
  });
});

describe("describeEntry", () => {
  test("names a command or a url, so the person recognises what changed", () => {
    expect(describeEntry({ type: "stdio", command: "/usr/local/bin/altana-mcp" })).toBe(
      "/usr/local/bin/altana-mcp",
    );
    expect(describeEntry({ type: "http", url: "https://mcp.altana.network" })).toBe(
      "https://mcp.altana.network",
    );
  });

  test("says something sensible about an entry it does not understand", () => {
    expect(describeEntry({ odd: true })).toContain("neither a command nor a url");
    expect(describeEntry("nonsense")).toContain("does not recognise");
  });
});

describe("homeIsTemporary", () => {
  test("spots an ALTANA_HOME inside the system temp directory", () => {
    // QA's trap: a real Chrome manifest naming a launcher that is about to be
    // deleted, with nothing saying so until the port will not open.
    expect(homeIsTemporary(join(tmpdir(), "altana-test-123"))).toBe(true);
    expect(homeIsTemporary("/tmp/altana")).toBe(true);
    expect(homeIsTemporary("/private/tmp/altana")).toBe(true);
  });

  test("leaves a real home alone", () => {
    expect(homeIsTemporary("/Users/someone/.altana")).toBe(false);
  });
});
