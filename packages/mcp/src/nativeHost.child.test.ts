import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame } from "./nativeFraming.js";
import { PROTOCOL } from "./nativeHost.js";

/**
 * The host as a separate process, talked to the way Chrome talks to it.
 *
 * Everything else about the host is tested in process, which is cheaper. This
 * file exists for the part that cannot be: that `altana-mcp native-host` really
 * starts, that argv dispatch reaches the host rather than the MCP server, that
 * stdout carries only frames, and that a reply survives a real pipe. Those are
 * exactly the things that fail first against Chrome.
 */

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.ts");

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-host-child-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

type Spoken = { frames: unknown[]; stderr: string; exitCode: number | null };

/** Send these requests to a real child process and read what comes back. */
async function speak(requests: unknown[], opts: { env?: Record<string, string> } = {}): Promise<Spoken> {
  const child = Bun.spawn([process.execPath, "run", CLI, "native-host"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ALTANA_HOME: home, ...opts.env },
  });

  const writer = child.stdin;
  for (const request of requests) writer.write(encodeFrame(request));
  await writer.flush();
  // Closing stdin is how Chrome ends a port, and it is what makes the host
  // finish rather than wait for more.
  await writer.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const decoder = new FrameDecoder();
  const decoded = decoder.push(Buffer.from(stdout));
  expect(decoder.pending).toBe(0);
  return {
    frames: decoded.map((f) => {
      if (!f.ok) throw new Error(`the child wrote a frame we cannot read: ${f.error}`);
      return f.value;
    }),
    stderr,
    exitCode,
  };
}

describe("altana-mcp native-host, as a child process", () => {
  test("answers hello over a real pipe and exits when the port closes", async () => {
    const { frames, exitCode } = await speak([{ id: "c1", type: "hello", payload: { extensionVersion: "0.1.0" } }]);
    const hello = frames.find((f) => (f as { id?: string }).id === "c1") as {
      ok: boolean;
      result: Record<string, unknown>;
    };
    expect(hello.ok).toBe(true);
    expect(hello.result.protocol).toBe(PROTOCOL);
    expect(hello.result.altanaHome).toBe(home);
    expect(exitCode).toBe(0);
  }, 20_000);

  test("stdout is frames only, with no stray line from the server's boot", async () => {
    // index.ts prints to stderr on boot and connects a JSON-RPC transport to
    // stdout. If argv dispatch leaked into it, this is where it shows: the
    // decoder would fail or the frames would be JSON-RPC.
    const { frames } = await speak([
      { id: "c2", type: "hello" },
      { id: "c3", type: "listAgents" },
    ]);
    expect(frames.map((f) => (f as { id?: string }).id)).toEqual(["c2", "c3"]);
  }, 20_000);

  test("several requests in one write each get their own answer", async () => {
    const { frames } = await speak([
      { id: "d1", type: "hello" },
      { id: "d2", type: "link", payload: { address: "0x3333333333333333333333333333333333333333", chainId: 97 } },
      { id: "d3", type: "listAgents" },
      { id: "d4", type: "unlink" },
    ]);
    expect(frames.map((f) => (f as { id?: string }).id)).toEqual(["d1", "d2", "d3", "d4"]);
    expect(frames.every((f) => (f as { ok?: boolean }).ok === true)).toBe(true);
  }, 20_000);

  test("a link made by the child is on disk for the MCP to read", async () => {
    const address = "0x4444444444444444444444444444444444444444";
    await speak([{ id: "e1", type: "link", payload: { address, chainId: 97 } }]);
    // The whole design: the host and the MCP never talk, they share ~/.altana.
    const link = JSON.parse(await readFile(join(home, "link.json"), "utf8"));
    expect(link).toMatchObject({ v: 1, address, chainId: 97 });
  }, 20_000);

  test("a session key sent to the child appears in neither its stdout nor its stderr", async () => {
    // The G8 property, proven against a real process rather than a function.
    const key = `0x${"cd".repeat(32)}`;
    const child = Bun.spawn([process.execPath, "run", CLI, "native-host"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ALTANA_HOME: home },
    });
    child.stdin.write(encodeFrame({ id: "f1", type: "sendSession", payload: { name: "bot", sessionPrivateKey: key } }));
    child.stdin.write(encodeFrame({ id: "f2", type: "hello" }));
    await child.stdin.flush();
    await child.stdin.end();

    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;

    expect(stdout).not.toContain(key);
    expect(stdout).not.toContain("cdcd");
    expect(stderr).not.toContain(key);
    expect(stderr).not.toContain("cdcd");
  }, 20_000);
});

describe("altana-mcp argv dispatch", () => {
  test("--version prints to stderr, leaving stdout clean for a protocol", async () => {
    const child = Bun.spawn([process.execPath, "run", CLI, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout).toBe("");
    expect(stderr.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(exitCode).toBe(0);
  }, 20_000);

  test("an unknown command fails with usage rather than starting a server", async () => {
    const child = Bun.spawn([process.execPath, "run", CLI, "teleport"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(stderr).toContain("no command called teleport");
    expect(exitCode).toBe(2);
  }, 20_000);
});
