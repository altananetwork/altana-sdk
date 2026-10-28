import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The MCP server as an agent actually runs it: a child process, JSON-RPC over
 * stdio, starting with an initialize that carries the client's own name.
 *
 * This is the only honest way to test the heartbeat and the not-connected
 * wording. Both depend on things that only exist once a real handshake has
 * happened: the client name the extension displays comes out of initialize, and
 * the wording replaces an error thrown from inside a tool call.
 *
 * Every run gets its own ALTANA_HOME and ALTANA_KEY_STORE, so nothing here
 * touches this machine's real ~/.altana or its keychain.
 */

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

let home: string;
let keyStore: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-mcp-stdio-"));
  keyStore = join(home, "keys.json");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

type Client = {
  call: (method: string, params?: unknown) => Promise<any>;
  notify: (method: string, params?: unknown) => Promise<void>;
  stop: () => Promise<void>;
  stderr: () => string;
};

/** Start the MCP and complete the handshake, as a client called `clientName`. */
async function startMcp(clientName: string, env: Record<string, string> = {}): Promise<Client> {
  const child = Bun.spawn([process.execPath, "run", CLI], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ALTANA_HOME: home,
      ALTANA_KEY_STORE: `file:${keyStore}`,
      // Named explicitly. An unset or misspelled chain must never be able to
      // put a test run on a mainnet.
      ALTANA_CHAIN: "bnb-testnet",
      ...env,
    },
  });

  let stderrText = "";
  void (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      stderrText += Buffer.from(chunk).toString("utf8");
    }
  })();

  // The stdio transport is newline delimited JSON, one message per line.
  const lines = (async function* () {
    let buffered = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffered += Buffer.from(chunk).toString("utf8");
      let at: number;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (line) yield line;
      }
    }
  })();

  let nextId = 1;
  const pending = new Map<number, (value: any) => void>();

  void (async () => {
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)!(message);
        pending.delete(message.id);
      }
    }
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

  const notify = async (method: string, params?: unknown) =>
    send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });

  const initialize = await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: clientName, version: "9.9.9" },
  });
  expect(initialize.result?.serverInfo?.name).toBe("altana-agentic-wallet");
  await notify("notifications/initialized");

  return {
    call,
    notify,
    stop: async () => {
      await child.stdin.end();
      child.kill();
      await child.exited;
    },
    stderr: () => stderrText,
  };
}

/** The agent heartbeat files currently in ALTANA_HOME. */
async function agentFiles(): Promise<string[]> {
  try {
    return (await readdir(join(home, "agents"))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
}

async function waitForAgentFile(timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = await agentFiles();
    if (files.length > 0) return files[0]!;
    if (Date.now() > deadline) throw new Error("no agent heartbeat file appeared");
    await Bun.sleep(50);
  }
}

/** The text of a tool result, whether it came back as a result or an error. */
function textOf(response: any): string {
  if (response.error) return JSON.stringify(response.error);
  return (response.result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

describe("the agent heartbeat (M3)", () => {
  test("appears from the initialize handshake, before any tool is called", async () => {
    // What G2 needs: the extension shows a running agent by its own name
    // within 10 seconds of it starting, and nobody has to ask it to do
    // anything first.
    const mcp = await startMcp("claude-code");
    try {
      const file = await waitForAgentFile();
      expect(file).toMatch(/^claude-code-\d+\.json$/);

      const parsed = JSON.parse(await readFile(join(home, "agents", file), "utf8"));
      expect(parsed.v).toBe(1);
      expect(parsed.client).toEqual({ name: "claude-code", version: "9.9.9" });
      expect(typeof parsed.pid).toBe("number");
      expect(Date.parse(parsed.startedAt)).not.toBeNaN();
      expect(Date.parse(parsed.lastSeen)).not.toBeNaN();

      // The pid has to be this child, or the host would call it not running.
      expect(() => process.kill(parsed.pid, 0)).not.toThrow();
      expect((await stat(join(home, "agents", file))).mode & 0o777).toBe(0o600);
    } finally {
      await mcp.stop();
    }
  }, 30_000);

  test("keeps the client's own name, slugging only the filename", async () => {
    // The contract says the extension displays client.name as the client sent
    // it. "Claude Desktop" must not be shown as "claude-desktop".
    const mcp = await startMcp("Claude Desktop");
    try {
      const file = await waitForAgentFile();
      expect(file).toMatch(/^claude-desktop-\d+\.json$/);
      const parsed = JSON.parse(await readFile(join(home, "agents", file), "utf8"));
      expect(parsed.client.name).toBe("Claude Desktop");
    } finally {
      await mcp.stop();
    }
  }, 30_000);

  test("lastSeen moves on a tool call, and startedAt does not", async () => {
    const mcp = await startMcp("claude-code");
    try {
      const file = await waitForAgentFile();
      const path = join(home, "agents", file);
      const before = JSON.parse(await readFile(path, "utf8"));

      await Bun.sleep(1100);
      const listed = await mcp.call("tools/call", { name: "list_sessions", arguments: {} });
      expect(listed.error).toBeUndefined();

      const after = JSON.parse(await readFile(path, "utf8"));
      expect(after.startedAt).toBe(before.startedAt);
      expect(new Date(after.lastSeen).getTime()).toBeGreaterThan(new Date(before.lastSeen).getTime());
    } finally {
      await mcp.stop();
    }
  }, 30_000);

  test("two agents of the same client each get their own file", async () => {
    const first = await startMcp("claude-code");
    const second = await startMcp("claude-code");
    try {
      await waitForAgentFile();
      // Both have written by the time both handshakes are done.
      const deadline = Date.now() + 10_000;
      let files = await agentFiles();
      while (files.length < 2 && Date.now() < deadline) {
        await Bun.sleep(50);
        files = await agentFiles();
      }
      expect(files).toHaveLength(2);
      expect(new Set(files).size).toBe(2);
    } finally {
      await first.stop();
      await second.stop();
    }
  }, 40_000);

  test("request_permission is not in tools/list yet, which is M7", async () => {
    // Recorded rather than assumed, because QA's probe flagged it and G5
    // rests on it. This test flips when M7 lands.
    const mcp = await startMcp("claude-code");
    try {
      const listed = await mcp.call("tools/list", {});
      const names = (listed.result?.tools ?? []).map((t: any) => t.name);
      expect(names).toContain("list_sessions");
      expect(names).toContain("wallet_balance");
      expect(names).not.toContain("request_permission");
    } finally {
      await mcp.stop();
    }
  }, 30_000);
});

describe("the not connected answer (M5)", () => {
  const NOT_CONNECTED =
    "This agent is not connected to an Altana wallet yet. Open the Altana extension " +
    "and click Connect to your agent.";

  test("a wallet tool with no key and no link says exactly that, and never mentions the keychain", async () => {
    const mcp = await startMcp("claude-code");
    try {
      const response = await mcp.call("tools/call", {
        name: "wallet_balance",
        arguments: { name: "default" },
      });
      const text = textOf(response);
      expect(text).toContain(NOT_CONNECTED);
      // The error this replaces named a keychain service and a file path, and
      // sent people looking for a broken keychain.
      expect(text.toLowerCase()).not.toContain("keychain");
      expect(text).not.toContain("keys.json");
    } finally {
      await mcp.stop();
    }
  }, 30_000);

  test("every tool that needs a wallet key says it, so the wording cannot drift", async () => {
    // All five call sites, which is the point of routing them through one
    // wrapper rather than repeating the sentence per tool.
    const mcp = await startMcp("claude-code");
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: "wallet_balance", arguments: { name: "default" } },
      { name: "list_fee_currencies", arguments: { name: "default" } },
      {
        name: "wallet_execute",
        arguments: { name: "default", to: "0x1111111111111111111111111111111111111111", valueEth: "0" },
      },
      {
        name: "grant_session",
        arguments: {
          walletName: "default",
          sessionName: "bot",
          recipient: "0x1111111111111111111111111111111111111111",
        },
      },
    ];
    try {
      for (const call of calls) {
        const text = textOf(await mcp.call("tools/call", call));
        expect(text).toContain(NOT_CONNECTED);
        expect(text.toLowerCase()).not.toContain("keychain");
      }
    } finally {
      await mcp.stop();
    }
  }, 40_000);

  test("with a link in place it explains that the wallet's key stays in the extension", async () => {
    // The other failure: somebody has connected, and the agent is being asked
    // to act as the wallet's admin, which it cannot do and never will.
    await writeFile(
      join(home, "link.json"),
      JSON.stringify({
        v: 1,
        address: "0x1111111111111111111111111111111111111111",
        chainId: 97,
        linkedAt: new Date().toISOString(),
      }),
    );
    const mcp = await startMcp("claude-code");
    try {
      const text = textOf(
        await mcp.call("tools/call", { name: "wallet_balance", arguments: { name: "default" } }),
      );
      expect(text).toContain(NOT_CONNECTED);
      expect(text).toContain("0x1111111111111111111111111111111111111111");
      expect(text).toContain("session_execute");
    } finally {
      await mcp.stop();
    }
  }, 30_000);
});

describe("wallet_balance and the linked wallet (M4)", () => {
  test("name is optional now, and its description points at the extension", async () => {
    const mcp = await startMcp("claude-code");
    try {
      const listed = await mcp.call("tools/list", {});
      const balance = (listed.result?.tools ?? []).find((t: any) => t.name === "wallet_balance");
      expect(balance.inputSchema.required ?? []).not.toContain("name");
      expect(JSON.stringify(balance.inputSchema)).toContain("extension connected");
    } finally {
      await mcp.stop();
    }
  }, 30_000);

  test("with no name and no link, it asks for a connection rather than a wallet name", async () => {
    const mcp = await startMcp("claude-code");
    try {
      const text = textOf(await mcp.call("tools/call", { name: "wallet_balance", arguments: {} }));
      expect(text).toContain("not connected to an Altana wallet yet");
    } finally {
      await mcp.stop();
    }
  }, 30_000);

  test("a link for another chain is refused by name, not answered with the wrong balance", async () => {
    // A plausible looking number for a chain nobody asked about is worse than
    // a refusal, because nothing about it looks wrong.
    await writeFile(
      join(home, "link.json"),
      JSON.stringify({
        v: 1,
        address: "0x2222222222222222222222222222222222222222",
        chainId: 56,
        linkedAt: new Date().toISOString(),
      }),
    );
    const mcp = await startMcp("claude-code");
    try {
      const text = textOf(await mcp.call("tools/call", { name: "wallet_balance", arguments: {} }));
      expect(text).toContain("chain 56");
      expect(text).toContain("chain 97");
      expect(text).toContain("ALTANA_CHAIN");
    } finally {
      await mcp.stop();
    }
  }, 30_000);
});
