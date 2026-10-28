/**
 * The agent heartbeat files in `~/.altana/agents/`.
 *
 * An agent is a running MCP client, and the extension has to show it by its own
 * name ("claude-code", "Claude Desktop", "Cursor") without knowing anything
 * about it in advance. The client tells us what it is called in the MCP
 * initialize handshake, so the MCP writes a small file per process and the
 * native host reads the directory.
 *
 * Two sides, in one module because they share a file format:
 *
 *   The MCP writes its own file at start and on every tool call (milestone M3).
 *   The native host reads them all and decides which are alive (milestone M1).
 *
 * `running` is a live pid check, not a timestamp comparison. An agent that was
 * hard killed leaves its file behind with a recent `lastSeen`, and showing that
 * as running is exactly the failure G2 is written to catch.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { altanaHome } from "./keys.js";

/** Where the heartbeat files live. Honours ALTANA_HOME through altanaHome(). */
export function agentsDir(): string {
  return join(altanaHome(), "agents");
}

/** The client half of a heartbeat, as the client itself reported it. */
export type AgentClient = {
  name: string;
  version?: string;
};

/** One heartbeat file. */
export type AgentFile = {
  v: 1;
  client: AgentClient;
  pid: number;
  startedAt: string;
  lastSeen: string;
};

/** A heartbeat plus the host's judgement of whether that process is alive. */
export type Agent = AgentFile & { running: boolean };

/**
 * A client name turned into something safe for a filename.
 *
 * Only the filename is slugged. The display name stays `client.name` exactly as
 * the client sent it, because the contract says the extension shows that, and a
 * person reading "Claude Desktop" should not see "claude-desktop".
 */
export function slugForClient(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A client that reports a name made entirely of punctuation would otherwise
  // produce an empty filename, which would collide with every other such client.
  return slug.length > 0 ? slug : "client";
}

/** The path this process writes its own heartbeat to. */
export function heartbeatPath(clientName: string, pid: number): string {
  return join(agentsDir(), `${slugForClient(clientName)}-${pid}.json`);
}

/**
 * Write (or refresh) this process's heartbeat.
 *
 * Written to a temporary name and renamed, because the host watches this
 * directory and a reader that catches a half-written file would see malformed
 * JSON for an agent that is perfectly healthy. Rename is atomic within a
 * filesystem, so a watcher sees either the old file or the new one.
 */
export async function writeHeartbeat(args: {
  client: AgentClient;
  pid?: number;
  startedAt: string;
}): Promise<string> {
  const pid = args.pid ?? process.pid;
  const path = heartbeatPath(args.client.name, pid);
  const file: AgentFile = {
    v: 1,
    client: args.client,
    pid,
    startedAt: args.startedAt,
    lastSeen: new Date().toISOString(),
  };
  await mkdir(agentsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/** Remove this process's heartbeat on a clean exit. Never throws. */
export async function removeHeartbeat(clientName: string, pid?: number): Promise<void> {
  await unlink(heartbeatPath(clientName, pid ?? process.pid)).catch(() => {});
}

/**
 * Remove this process's heartbeat from an exit handler.
 *
 * Synchronous because `process.on("exit")` cannot await, and that is the one
 * handler that runs for an ordinary end of stdin. Without it the file lingers
 * until the host next reaps it, and for those few seconds the extension shows
 * an agent that has already gone.
 */
export function removeHeartbeatSync(clientName: string, pid?: number): void {
  try {
    unlinkSync(heartbeatPath(clientName, pid ?? process.pid));
  } catch {
    /* already gone, or never written */
  }
}

/**
 * Is that pid alive?
 *
 * Signal 0 asks the kernel without delivering anything. EPERM means the process
 * exists and belongs to somebody else, which still counts as running.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Every heartbeat in the directory, each with `running`.
 *
 * A file that cannot be read or parsed is skipped rather than failing the whole
 * listing: one bad file must not hide a working agent from the extension. A
 * missing directory is an empty list, which is the honest answer before any
 * agent has ever started.
 */
export async function readAgents(): Promise<Agent[]> {
  let names: string[];
  try {
    names = await readdir(agentsDir());
  } catch {
    return [];
  }
  const agents: Agent[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = await readAgentFile(join(agentsDir(), name));
    if (parsed) agents.push({ ...parsed, running: pidAlive(parsed.pid) });
  }
  // Stable order, so two listings of an unchanged directory compare equal and
  // the host does not send an agents.changed event for a reshuffle.
  agents.sort((a, b) => a.client.name.localeCompare(b.client.name) || a.pid - b.pid);
  return agents;
}

async function readAgentFile(path: string): Promise<AgentFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AgentFile>;
    const client = parsed.client;
    if (typeof parsed.pid !== "number" || !client || typeof client.name !== "string") {
      return undefined;
    }
    return {
      v: 1,
      client: {
        name: client.name,
        ...(typeof client.version === "string" ? { version: client.version } : {}),
      },
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString(),
      lastSeen: typeof parsed.lastSeen === "string" ? parsed.lastSeen : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Delete heartbeat files whose process is gone.
 *
 * Called by the host when it notices a dead pid. Without this, a directory
 * accumulates one file per agent that ever ran, and every listing pays to read
 * them. Best effort: losing a race with another reaper is not an error.
 */
export async function reapDeadAgents(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(agentsDir());
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(agentsDir(), name);
    const parsed = await readAgentFile(path);
    if (parsed && !pidAlive(parsed.pid)) {
      await unlink(path).then(
        () => {
          reaped += 1;
        },
        () => {},
      );
    }
  }
  return reaped;
}
