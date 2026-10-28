import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "./nativeFraming.js";

/**
 * The MCP and the native host, as two real processes, with `~/.altana` as the
 * only thing between them.
 *
 * That is the whole design in the contract: they never talk to each other. So
 * the claim worth testing is not that either side works alone, which the other
 * test files cover, but that an agent the MCP wrote is an agent the host
 * reports. This is the backend half of G2, and it is here rather than in a
 * script so that it keeps being checked.
 */

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

let home: string;
let env: Record<string, string>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-cross-"));
  env = {
    ...process.env,
    ALTANA_HOME: home,
    ALTANA_KEY_STORE: `file:${join(home, "keys.json")}`,
    // Named, never left to a default. A misspelled chain must not be able to
    // put a test run on a mainnet.
    ALTANA_CHAIN: "bnb-testnet",
  } as Record<string, string>;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

type Frames = { responses: any[]; events: any[] };

/** One short-lived host, the way Chrome opens and closes a port. */
async function askHost(requests: unknown[]): Promise<Frames> {
  const host = Bun.spawn([process.execPath, "run", CLI, "native-host"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  for (const request of requests) host.stdin.write(encodeFrame(request));
  await host.stdin.flush();
  await host.stdin.end();

  const stdout = Buffer.from(await new Response(host.stdout).arrayBuffer());
  await new Response(host.stderr).text();
  await host.exited;

  const decoder = new FrameDecoder();
  const all = decoder.push(stdout).map((f) => {
    if (!f.ok) throw new Error(`unreadable frame: ${f.error}`);
    return f.value as any;
  });
  // Events and responses share the channel, and an event can arrive first, so
  // a caller must never just take the first frame.
  return {
    responses: all.filter((f) => typeof f.id === "string"),
    events: all.filter((f) => typeof f.event === "string"),
  };
}

function answerTo(frames: Frames, id: string): any {
  return frames.responses.find((r) => r.id === id);
}

type Agent = {
  pid: number;
  call: (method: string, params?: unknown) => Promise<any>;
  stop: () => Promise<void>;
};

/**
 * An MCP with the handshake done, as a client calling itself `name`.
 *
 * Both of its streams are drained from the start, because a full pipe blocks
 * the server, and replies are matched by id so a caller never has to guess
 * which line is theirs.
 */
async function startAgent(name: string): Promise<Agent> {
  const child = Bun.spawn([process.execPath, "run", CLI], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  let nextId = 2;
  const pending = new Map<number, (value: any) => void>();

  void (async () => {
    let buffered = "";
    for await (const chunk of child.stdout as any) {
      buffered += Buffer.from(chunk).toString("utf8");
      let at: number;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (typeof parsed.id === "number" && pending.has(parsed.id)) {
          pending.get(parsed.id)!(parsed);
          pending.delete(parsed.id);
        }
      }
    }
  })();
  void (async () => {
    for await (const _ of child.stderr as any) void _;
  })();

  const send = async (payload: unknown) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    await child.stdin.flush();
  };

  const call = async (method: string, params?: unknown) => {
    const id = nextId++;
    const answer = new Promise<any>((done) => pending.set(id, done));
    await send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return await answer;
  };

  const handshake = new Promise<any>((done) => pending.set(1, done));
  await send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name, version: "2.1.312" },
    },
  });
  await handshake;
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    pid: child.pid,
    call,
    stop: async () => {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}

/** Poll the host until it reports an agent, or give up. */
async function waitForAgent(id: string, timeoutMs = 10_000): Promise<{ agent: any; ms: number }> {
  const from = Date.now();
  for (;;) {
    const frames = await askHost([{ id, type: "listAgents" }]);
    const agent = (answerTo(frames, id)?.result?.agents ?? [])[0];
    if (agent) return { agent, ms: Date.now() - from };
    if (Date.now() - from > timeoutMs) return { agent: undefined, ms: Date.now() - from };
    await Bun.sleep(100);
  }
}

describe("an agent the MCP wrote is an agent the host reports", () => {
  test("nothing is reported before any agent has run", async () => {
    const frames = await askHost([{ id: "a", type: "listAgents" }]);
    expect(answerTo(frames, "a").result.agents).toEqual([]);
  }, 30_000);

  test("it appears well inside the ten seconds G2 allows, by its own name", async () => {
    const agent = await startAgent("claude-code");
    try {
      const { agent: seen, ms } = await waitForAgent("b");
      expect(seen).toBeDefined();
      expect(ms).toBeLessThan(10_000);
      expect(seen.client).toEqual({ name: "claude-code", version: "2.1.312" });
      expect(seen.running).toBe(true);
      expect(seen.pid).toBe(agent.pid);
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("after a hard kill it is never reported as running again", async () => {
    // The failure G2 exists to catch. A hard kill leaves the file behind with
    // a fresh lastSeen, so anything that trusted the timestamp would show a
    // dead agent as alive.
    const agent = await startAgent("claude-code");
    const { agent: seen } = await waitForAgent("c");
    expect(seen?.running).toBe(true);

    await agent.stop();

    const from = Date.now();
    for (;;) {
      const frames = await askHost([{ id: "d", type: "listAgents" }]);
      const agents = answerTo(frames, "d")?.result?.agents ?? [];
      const still = agents.find((a: any) => a.pid === seen.pid);
      // Either gone or listed as stopped. Both are correct; what must never
      // happen is running true.
      if (!still || still.running === false) break;
      expect(Date.now() - from).toBeLessThan(10_000);
      await Bun.sleep(100);
    }
  }, 40_000);

  test("the host says agents.changed without being asked", async () => {
    // How the extension finds out, rather than polling.
    const agent = await startAgent("Claude Desktop");
    try {
      await waitForAgent("e");
      const from = Date.now();
      for (;;) {
        const frames = await askHost([{ id: "f", type: "hello" }]);
        const changed = frames.events.find((ev) => ev.event === "agents.changed");
        if (changed) {
          expect(changed.payload.agents.map((a: any) => a.client.name)).toContain("Claude Desktop");
          break;
        }
        expect(Date.now() - from).toBeLessThan(10_000);
        await Bun.sleep(100);
      }
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("a link the host writes is a link the MCP reads", async () => {
    // The same channel in the other direction, which is what M4 rests on.
    const address = "0x5555555555555555555555555555555555555555";
    const frames = await askHost([{ id: "g", type: "link", payload: { address, chainId: 97 } }]);
    expect(answerTo(frames, "g").result).toEqual({ linked: true });

    const agent = await startAgent("claude-code");
    try {
      const reply = await agent.call("tools/call", { name: "wallet_balance", arguments: {} });
      // It got as far as the linked address, which is the thing being proven.
      // Whether the balance call then succeeds depends on a relay, so what is
      // asserted is that it is no longer asking to be connected.
      const text = JSON.stringify(reply);
      expect(text).not.toContain("not connected to an Altana wallet yet");
      expect(text.toLowerCase()).toContain(address.toLowerCase().slice(2, 10));
    } finally {
      await agent.stop();
    }
  }, 40_000);
});
