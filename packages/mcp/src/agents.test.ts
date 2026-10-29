import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsDir,
  heartbeatPath,
  pidAlive,
  readAgents,
  reapDeadAgents,
  removeHeartbeat,
  slugForClient,
  writeHeartbeat,
} from "./agents.js";

let home: string;
const realHome = process.env.ALTANA_HOME;

beforeEach(async () => {
  // Never the real ~/.altana: it holds this machine's actual sessions.
  home = await mkdtemp(join(tmpdir(), "altana-agents-"));
  process.env.ALTANA_HOME = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

/** A pid that cannot be running: above the kernel's maximum. */
const DEAD_PID = 4194304;

describe("slugForClient", () => {
  test("lowercases and collapses anything that is not a letter or digit", () => {
    expect(slugForClient("Claude Desktop")).toBe("claude-desktop");
    expect(slugForClient("claude-code")).toBe("claude-code");
    expect(slugForClient("Cursor 1.2 (beta)")).toBe("cursor-1-2-beta");
  });

  test("does not leave a leading or trailing dash", () => {
    expect(slugForClient("  spaced  ")).toBe("spaced");
    expect(slugForClient("!!weird!!")).toBe("weird");
  });

  test("a name with nothing usable in it still gives a filename", () => {
    // Otherwise two such clients would write to the same empty name.
    expect(slugForClient("!!!")).toBe("client");
  });
});

describe("writeHeartbeat", () => {
  test("writes the contract's shape, 0600 in a 0700 directory", async () => {
    const path = await writeHeartbeat({
      client: { name: "claude-code", version: "2.1.312" },
      pid: process.pid,
      startedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(path).toBe(heartbeatPath("claude-code", process.pid));

    const file = JSON.parse(await readFile(path, "utf8"));
    expect(file.v).toBe(1);
    expect(file.client).toEqual({ name: "claude-code", version: "2.1.312" });
    expect(file.pid).toBe(process.pid);
    expect(file.startedAt).toBe("2026-10-28T12:00:00.000Z");
    expect(typeof file.lastSeen).toBe("string");

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(agentsDir())).mode & 0o777).toBe(0o700);
  });

  test("leaves no temporary file behind, so a watcher never sees one", async () => {
    await writeHeartbeat({ client: { name: "claude-code" }, startedAt: new Date().toISOString() });
    const names = await readdir(agentsDir());
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("refreshing moves lastSeen and leaves startedAt where it was", async () => {
    const startedAt = "2026-10-28T12:00:00.000Z";
    const path = await writeHeartbeat({ client: { name: "claude-code" }, startedAt });
    const first = JSON.parse(await readFile(path, "utf8"));
    await Bun.sleep(5);
    await writeHeartbeat({ client: { name: "claude-code" }, startedAt });
    const second = JSON.parse(await readFile(path, "utf8"));
    expect(second.startedAt).toBe(startedAt);
    expect(new Date(second.lastSeen).getTime()).toBeGreaterThan(new Date(first.lastSeen).getTime() - 1);
  });

  test("one file per process, so two agents of the same client both show", async () => {
    await writeHeartbeat({ client: { name: "claude-code" }, pid: process.pid, startedAt: "x" });
    await writeHeartbeat({ client: { name: "claude-code" }, pid: DEAD_PID, startedAt: "x" });
    expect(await readAgents()).toHaveLength(2);
  });
});

describe("pidAlive", () => {
  test("true for this process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("false for a pid that cannot exist", () => {
    expect(pidAlive(DEAD_PID)).toBe(false);
  });

  test("false for nonsense rather than throwing", () => {
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
  });
});

describe("readAgents", () => {
  test("no directory is an empty list, which is the honest answer before any agent runs", async () => {
    expect(await readAgents()).toEqual([]);
  });

  test("running comes from the pid, not from lastSeen", async () => {
    // The failure G2 is written to catch: an agent that was hard killed leaves
    // a file with a recent lastSeen, and must not be shown as running.
    await writeHeartbeat({ client: { name: "live" }, pid: process.pid, startedAt: "x" });
    await writeHeartbeat({ client: { name: "dead" }, pid: DEAD_PID, startedAt: "x" });

    const agents = await readAgents();
    expect(agents.find((a) => a.client.name === "live")?.running).toBe(true);
    const dead = agents.find((a) => a.client.name === "dead");
    expect(dead?.running).toBe(false);
    expect(new Date(dead!.lastSeen).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("keeps the client's own name exactly as it sent it", async () => {
    // The filename is slugged, the display name is not: the contract says the
    // extension shows client.name.
    await writeHeartbeat({ client: { name: "Claude Desktop" }, startedAt: "x" });
    expect((await readAgents())[0]?.client.name).toBe("Claude Desktop");
  });

  test("one unreadable file does not hide a working agent", async () => {
    await mkdir(agentsDir(), { recursive: true });
    await writeFile(join(agentsDir(), "broken-1.json"), "{ not json");
    await writeFile(join(agentsDir(), "no-pid-2.json"), JSON.stringify({ v: 1, client: { name: "x" } }));
    await writeHeartbeat({ client: { name: "good" }, pid: process.pid, startedAt: "x" });

    const agents = await readAgents();
    expect(agents.map((a) => a.client.name)).toEqual(["good"]);
  });

  test("ignores files that are not JSON files", async () => {
    await mkdir(agentsDir(), { recursive: true });
    await writeFile(join(agentsDir(), "notes.txt"), "ignore me");
    expect(await readAgents()).toEqual([]);
  });

  test("order is stable, so two unchanged listings compare equal", async () => {
    await writeHeartbeat({ client: { name: "zeta" }, pid: process.pid, startedAt: "x" });
    await writeHeartbeat({ client: { name: "alpha" }, pid: process.pid + 1, startedAt: "x" });
    expect((await readAgents()).map((a) => a.client.name)).toEqual(["alpha", "zeta"]);
    expect(await readAgents()).toEqual(await readAgents());
  });
});

describe("reapDeadAgents", () => {
  test("removes the dead and keeps the living", async () => {
    await writeHeartbeat({ client: { name: "live" }, pid: process.pid, startedAt: "x" });
    await writeHeartbeat({ client: { name: "dead" }, pid: DEAD_PID, startedAt: "x" });

    expect(await reapDeadAgents()).toBe(1);
    expect((await readAgents()).map((a) => a.client.name)).toEqual(["live"]);
  });

  test("nothing to reap is not an error", async () => {
    expect(await reapDeadAgents()).toBe(0);
  });
});

describe("removeHeartbeat", () => {
  test("removes this process's file and does not mind if it is already gone", async () => {
    await writeHeartbeat({ client: { name: "claude-code" }, startedAt: "x" });
    await removeHeartbeat("claude-code");
    expect(await readAgents()).toEqual([]);
    await removeHeartbeat("claude-code");
  });
});
