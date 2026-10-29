import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey } from "viem/accounts";
import { signerFromPrivateKey, type SerializedSession } from "@altananetwork/sdk";
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


/**
 * A handover the extension could really have sent.
 *
 * Built here with no chain involved, because what makes one storable is that
 * its publicKey is the public half of the key beside it.
 */
function handoff(name: string, expirySeconds = 604800) {
  const privateKey = generatePrivateKey();
  const signer = signerFromPrivateKey(privateKey);
  const wallet = "0x1111111111111111111111111111111111111111";
  const session: SerializedSession = {
    walletAddress: wallet,
    publicKey: signer.publicKey,
    permissions: {
      calls: [{ to: "0x2222222222222222222222222222222222222222" }],
      spend: [{ limit: "1000000000000000", period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + expirySeconds,
  };
  return {
    privateKey,
    session,
    payload: {
      name,
      chainId: 97,
      walletAddress: wallet,
      serializedSession: JSON.stringify(session),
      sessionPrivateKey: privateKey,
    },
  };
}

describe("a permission the host stores is a permission the MCP can use (M6)", () => {
  test("list_sessions sees it on the next call, from a process started afterwards", async () => {
    // The contract's actual promise. The host writes, the MCP reads, and there
    // is no restart or handshake between them other than ~/.altana.
    const { payload, session } = handoff("trading-bot");
    const frames = await askHost([{ id: "s1", type: "sendSession", payload }]);
    const answer = answerTo(frames, "s1");
    expect(answer.ok).toBe(true);
    expect(answer.result).toMatchObject({ stored: true, name: "trading-bot" });

    const agent = await startAgent("claude-code");
    try {
      const listed = await agent.call("tools/call", { name: "list_sessions", arguments: {} });
      const text = JSON.stringify(listed);
      expect(text).toContain("trading-bot");
      expect(text).toContain(session.publicKey);
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("an agent already running sees it on its next call, with no restart", async () => {
    // "without restarting" is in G3 word for word, so it gets its own test:
    // the agent starts first, the permission arrives second.
    const agent = await startAgent("claude-code");
    try {
      const before = await agent.call("tools/call", { name: "list_sessions", arguments: {} });
      expect(JSON.stringify(before)).not.toContain("late-arrival");

      const { payload } = handoff("late-arrival");
      const frames = await askHost([{ id: "s2", type: "sendSession", payload }]);
      expect(answerTo(frames, "s2").ok).toBe(true);

      const after = await agent.call("tools/call", { name: "list_sessions", arguments: {} });
      expect(JSON.stringify(after)).toContain("late-arrival");
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("session_execute finds it and rebuilds it, rather than saying there is no such session", async () => {
    // How far this can go without a chain: the proof is that the failure is
    // about the network and not about a missing or unrebuildable session.
    const { payload } = handoff("executable");
    await askHost([{ id: "s3", type: "sendSession", payload }]);

    const agent = await startAgent("claude-code");
    try {
      const executed = await agent.call("tools/call", {
        name: "session_execute",
        arguments: {
          sessionName: "executable",
          to: "0x2222222222222222222222222222222222222222",
          valueEth: "0",
        },
      });
      const text = JSON.stringify(executed);
      expect(text).not.toContain("No session named");
      expect(text).not.toContain("does not belong to that session");
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("the key reaches the key store and nothing else", async () => {
    const { payload, privateKey } = handoff("secret-bot");
    const frames = await askHost([{ id: "s4", type: "sendSession", payload }]);

    // Not in the answer, which is what the extension logs.
    expect(JSON.stringify(frames)).not.toContain(privateKey.slice(2));
    // Not in the session metadata, which is world readable to this user.
    const sessions = await Bun.file(join(home, "sessions.json")).text();
    expect(sessions).not.toContain(privateKey.slice(2));
    // In the key store, because session_execute has to be able to sign.
    const keys = await Bun.file(join(home, "keys.json")).text();
    expect(keys).toContain(privateKey);
  }, 40_000);

  test("a second permission of the same name is NAME_TAKEN, and the first survives", async () => {
    const first = handoff("only-one");
    const second = handoff("only-one");
    await askHost([{ id: "s5", type: "sendSession", payload: first.payload }]);
    const frames = await askHost([{ id: "s6", type: "sendSession", payload: second.payload }]);

    expect(answerTo(frames, "s6")).toMatchObject({
      ok: false,
      error: { code: "NAME_TAKEN" },
    });
    const sessions = await Bun.file(join(home, "sessions.json")).text();
    expect(sessions).toContain(first.session.publicKey);
    expect(sessions).not.toContain(second.session.publicKey);
  }, 40_000);

  test("a mismatched pair is BAD_REQUEST and stores nothing", async () => {
    const { payload } = handoff("mismatched");
    const frames = await askHost([
      {
        id: "s7",
        type: "sendSession",
        payload: { ...payload, sessionPrivateKey: generatePrivateKey() },
      },
      { id: "s8", type: "listAgents" },
    ]);
    expect(answerTo(frames, "s7")).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    // The port is still usable afterwards: a refused handover is not a crash.
    expect(answerTo(frames, "s8").ok).toBe(true);
    expect(await Bun.file(join(home, "sessions.json")).exists()).toBe(false);
  }, 40_000);
});


describe("a revoked permission is refused, and says so (M8, G6)", () => {
  test("the agent's next session_execute names the revoke instead of an unknown session", async () => {
    // G6 in one test. The wording is the deliverable: "no session named X"
    // reads as a typo or a bug and sends an agent looking for another way
    // through, which is the opposite of what a revoke means.
    const { payload } = handoff("to-revoke");
    await askHost([{ id: "v1", type: "sendSession", payload }]);

    const agent = await startAgent("claude-code");
    try {
      const before = await agent.call("tools/call", { name: "list_sessions", arguments: {} });
      expect(JSON.stringify(before)).toContain("to-revoke");

      const frames = await askHost([{ id: "v2", type: "revokeSession", payload: { name: "to-revoke" } }]);
      expect(answerTo(frames, "v2")).toMatchObject({ ok: true, result: { removed: true } });

      // The same running agent, no restart, which is what G6 asks.
      const after = await agent.call("tools/call", {
        name: "session_execute",
        arguments: {
          sessionName: "to-revoke",
          to: "0x2222222222222222222222222222222222222222",
          valueEth: "0",
        },
      });
      const text = JSON.stringify(after);
      expect(text).toContain("was revoked");
      expect(text).toContain("the person who owns the wallet");
      expect(text).toContain("not a fault to retry");
      expect(text).not.toContain("No session named");
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("the key and the metadata are both gone, not just one of them", async () => {
    const { payload, privateKey } = handoff("gone");
    await askHost([{ id: "v3", type: "sendSession", payload }]);
    expect(await Bun.file(join(home, "keys.json")).text()).toContain(privateKey);

    await askHost([{ id: "v4", type: "revokeSession", payload: { name: "gone" } }]);

    // A key left behind after a revoke is a key that can still sign.
    expect(await Bun.file(join(home, "keys.json")).text()).not.toContain(privateKey);
    expect(await Bun.file(join(home, "sessions.json")).text()).not.toContain("gone");
  }, 40_000);

  test("the host says session.revoked without being asked", async () => {
    const { payload } = handoff("announced");
    await askHost([{ id: "v5", type: "sendSession", payload }]);
    const frames = await askHost([{ id: "v6", type: "revokeSession", payload: { name: "announced" } }]);
    const event = frames.events.find((e) => e.event === "session.revoked");
    expect(event?.payload).toEqual({ name: "announced" });
  }, 40_000);

  test("revoking something already gone still leaves the better answer behind", async () => {
    // The extension may be reconciling after a crash. removed is false, but
    // the agent should still get the useful wording next time it tries.
    const frames = await askHost([{ id: "v7", type: "revokeSession", payload: { name: "never-here" } }]);
    expect(answerTo(frames, "v7")).toMatchObject({ ok: true, result: { removed: false } });

    const agent = await startAgent("claude-code");
    try {
      const after = await agent.call("tools/call", {
        name: "session_execute",
        arguments: {
          sessionName: "never-here",
          to: "0x2222222222222222222222222222222222222222",
          valueEth: "0",
        },
      });
      expect(JSON.stringify(after)).toContain("was revoked");
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("a name can be used again, and is not reported as revoked afterwards", async () => {
    await askHost([{ id: "v8", type: "sendSession", payload: handoff("reused").payload }]);
    await askHost([{ id: "v9", type: "revokeSession", payload: { name: "reused" } }]);
    await askHost([{ id: "v10", type: "sendSession", payload: handoff("reused").payload }]);

    const agent = await startAgent("claude-code");
    try {
      const listed = await agent.call("tools/call", { name: "list_sessions", arguments: {} });
      expect(JSON.stringify(listed)).toContain("reused");
      const executed = await agent.call("tools/call", {
        name: "session_execute",
        arguments: {
          sessionName: "reused",
          to: "0x2222222222222222222222222222222222222222",
          valueEth: "0",
        },
      });
      // Whatever else happens without a chain, it must not claim the fresh
      // permission was revoked.
      expect(JSON.stringify(executed)).not.toContain("was revoked");
    } finally {
      await agent.stop();
    }
  }, 40_000);

  test("revoke_session on an imported permission stops using it and says what it did not do", async () => {
    // It used to reach getWalletKey("imported") and fail with a keychain
    // error. Claiming "revoked" would be worse than useless: the key would
    // still be live on chain while everyone believed it was dead.
    await askHost([{ id: "v11", type: "sendSession", payload: handoff("agent-side").payload }]);
    const agent = await startAgent("claude-code");
    try {
      const revoked = await agent.call("tools/call", {
        name: "revoke_session",
        arguments: { sessionName: "agent-side" },
      });
      const text = JSON.stringify(revoked);
      expect(text).toContain("removedLocally");
      expect(text).toContain("NOT revoked on chain");
      expect(text).toContain("only the extension");
      expect(text.toLowerCase()).not.toContain("keychain");

      const listed = await agent.call("tools/call", { name: "list_sessions", arguments: {} });
      expect(JSON.stringify(listed)).not.toContain("agent-side");
    } finally {
      await agent.stop();
    }
  }, 40_000);
});


describe("the host announces a request without being asked (M7, G5)", () => {
  /**
   * Keep a host's port open and collect its event frames, the way the
   * extension does, rather than opening a port per question.
   *
   * The other tests here open and close a port per request, which can never
   * see an event that arrives while a port is open. request.created is only
   * ever an unprompted event, so it needs a port that stays open.
   */
  async function openPort() {
    const host = Bun.spawn([process.execPath, "run", CLI, "native-host"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const events: any[] = [];
    const responses: any[] = [];
    void (async () => {
      const decoder = new FrameDecoder();
      for await (const chunk of host.stdout as any) {
        for (const frame of decoder.push(Buffer.from(chunk))) {
          if (!frame.ok) continue;
          const value = frame.value as any;
          if (typeof value.event === "string") events.push(value);
          else responses.push(value);
        }
      }
    })();
    void (async () => {
      for await (const _ of host.stderr as any) void _;
    })();

    return {
      events,
      responses,
      ask: async (request: unknown) => {
        host.stdin.write(encodeFrame(request));
        await host.stdin.flush();
      },
      waitForEvent: async (name: string, timeoutMs = 15_000) => {
        const from = Date.now();
        for (;;) {
          const found = events.find((e) => e.event === name);
          if (found) return found;
          if (Date.now() - from > timeoutMs) return undefined;
          await Bun.sleep(100);
        }
      },
      close: async () => {
        await host.stdin.end();
        host.kill();
        await host.exited;
      },
    };
  }

  /** Write a pending request the way the MCP's request_permission does. */
  async function writeRequest(id: string, name: string) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = join(home, "requests");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const request = {
      v: 1,
      id,
      client: { name: "claude-code", version: "2.1.312" },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: "pending",
      ask: {
        name,
        chainId: 97,
        spend: [{ limit: "1000000000000000", period: "day" }],
        expirySeconds: 604800,
        reason: "I want to rebalance the position you asked about.",
      },
      answer: null,
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(request, null, 2), { mode: 0o600 });
    return request;
  }

  test("a request written while the port is open is announced, with the agent's own words", async () => {
    const port = await openPort();
    try {
      // Nothing waiting yet, so nothing to announce.
      expect(await port.waitForEvent("request.created", 1500)).toBeUndefined();

      await writeRequest("11111111-1111-1111-1111-111111111111", "trading-bot");
      const event = await port.waitForEvent("request.created");
      expect(event).toBeDefined();
      expect(event.payload.request.id).toBe("11111111-1111-1111-1111-111111111111");
      expect(event.payload.request.ask.name).toBe("trading-bot");
      // The reason is what the person reads before deciding, so it has to
      // survive the trip verbatim.
      expect(event.payload.request.ask.reason).toBe(
        "I want to rebalance the position you asked about.",
      );
      expect(event.payload.request.client.name).toBe("claude-code");
    } finally {
      await port.close();
    }
  }, 40_000);

  test("one already waiting is announced when the port opens, which is the Chrome restart case", async () => {
    // The agent is still waiting and nothing else would say so.
    await writeRequest("22222222-2222-2222-2222-222222222222", "late-badge");
    const port = await openPort();
    try {
      const event = await port.waitForEvent("request.created");
      expect(event?.payload.request.id).toBe("22222222-2222-2222-2222-222222222222");
    } finally {
      await port.close();
    }
  }, 40_000);

  test("it is announced once, not once per poll", async () => {
    const port = await openPort();
    try {
      await writeRequest("33333333-3333-3333-3333-333333333333", "once-only");
      await port.waitForEvent("request.created");
      // Several poll intervals, so a watcher that re-announced would show it.
      await Bun.sleep(5000);
      const created = port.events.filter((e) => e.event === "request.created");
      expect(created).toHaveLength(1);
    } finally {
      await port.close();
    }
  }, 40_000);

  test("answering it stops it being pending, and a second one is still announced", async () => {
    const port = await openPort();
    try {
      await writeRequest("44444444-4444-4444-4444-444444444444", "first");
      await port.waitForEvent("request.created");

      await port.ask({
        id: "ans",
        type: "answerRequest",
        payload: { id: "44444444-4444-4444-4444-444444444444", decision: "reject" },
      });
      const from = Date.now();
      while (!port.responses.some((r) => r.id === "ans") && Date.now() - from < 10_000) {
        await Bun.sleep(100);
      }
      expect(port.responses.find((r) => r.id === "ans")).toMatchObject({ ok: true });

      // listRequests is pending only, so the answered one is gone from it.
      await port.ask({ id: "list", type: "listRequests" });
      const listFrom = Date.now();
      while (!port.responses.some((r) => r.id === "list") && Date.now() - listFrom < 10_000) {
        await Bun.sleep(100);
      }
      expect(port.responses.find((r) => r.id === "list").result.requests).toEqual([]);

      await writeRequest("55555555-5555-5555-5555-555555555555", "second");
      const from2 = Date.now();
      for (;;) {
        const ids = port.events
          .filter((e) => e.event === "request.created")
          .map((e) => e.payload.request.id);
        if (ids.includes("55555555-5555-5555-5555-555555555555")) break;
        expect(Date.now() - from2).toBeLessThan(15_000);
        await Bun.sleep(100);
      }
    } finally {
      await port.close();
    }
  }, 60_000);
});
