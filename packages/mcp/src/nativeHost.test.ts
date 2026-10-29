import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeartbeat } from "./agents.js";
import { readLink } from "./link.js";
import { encodeFrame, FrameDecoder, MAX_INBOUND_BYTES } from "./nativeFraming.js";
import { PROTOCOL, runNativeHost, type HostEvent, type HostResponse } from "./nativeHost.js";
import { VERSION } from "./version.js";

let home: string;
const realHome = process.env.ALTANA_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-host-"));
  process.env.ALTANA_HOME = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

type Talk = {
  responses: HostResponse[];
  events: HostEvent[];
  stderr: string[];
  /** Every byte the host wrote, for the key leak check. */
  wire: string;
};

/**
 * Run the host over a fixed list of requests and collect everything it wrote.
 *
 * In-process rather than spawned, so every request type is cheap to cover. The
 * child process case has its own test below, because the framing over a real
 * pipe is the thing that is worth proving separately.
 */
async function talk(requests: unknown[]): Promise<Talk> {
  const chunks: Buffer[] = [];
  const stderr: string[] = [];
  await runNativeHost({
    input: (async function* () {
      for (const request of requests) yield encodeFrame(request);
    })(),
    write: (bytes) => void chunks.push(Buffer.from(bytes)),
    log: (line) => void stderr.push(line),
  });

  const decoder = new FrameDecoder();
  const responses: HostResponse[] = [];
  const events: HostEvent[] = [];
  for (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) {
      if (!frame.ok) throw new Error(`the host wrote a frame we cannot read: ${frame.error}`);
      const value = frame.value as HostResponse & HostEvent;
      if ("event" in value && value.event) events.push(value);
      else responses.push(value);
    }
  }
  return { responses, events, stderr, wire: Buffer.concat(chunks).toString("utf8") };
}

function ok(response: HostResponse | undefined): Record<string, unknown> {
  if (!response || !response.ok) {
    throw new Error(`expected a success, got ${JSON.stringify(response)}`);
  }
  return response.result as Record<string, unknown>;
}

describe("hello", () => {
  test("answers the contract's fields, and touches no store", async () => {
    // If hello works, the manifest, the launcher, the allowed origin and the
    // framing are all right. That is G1.
    const { responses } = await talk([{ id: "h1", type: "hello", payload: { extensionVersion: "0.1.0" } }]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe("h1");
    expect(ok(responses[0])).toMatchObject({
      hostVersion: VERSION,
      mcpVersion: VERSION,
      altanaHome: home,
      protocol: PROTOCOL,
      sawExtensionVersion: "0.1.0",
    });
  });

  test("works with no payload at all", async () => {
    const { responses } = await talk([{ id: "h2", type: "hello" }]);
    expect(ok(responses[0]).protocol).toBe(PROTOCOL);
  });
});

describe("listAgents", () => {
  test("empty before any agent has run", async () => {
    const { responses } = await talk([{ id: "a1", type: "listAgents" }]);
    expect(ok(responses[0])).toEqual({ agents: [] });
  });

  test("reports a live agent as running and a dead one as not", async () => {
    await writeHeartbeat({ client: { name: "claude-code" }, pid: process.pid, startedAt: "x" });
    await writeHeartbeat({ client: { name: "gone" }, pid: 4194304, startedAt: "x" });

    const { responses } = await talk([{ id: "a2", type: "listAgents" }]);
    const agents = ok(responses[0]).agents as { client: { name: string }; running: boolean }[];
    expect(agents.find((a) => a.client.name === "claude-code")?.running).toBe(true);
    expect(agents.find((a) => a.client.name === "gone")?.running).toBe(false);
  });
});

describe("link and unlink", () => {
  test("link writes link.json and says so", async () => {
    const address = "0x1111111111111111111111111111111111111111";
    const { responses } = await talk([{ id: "l1", type: "link", payload: { address, chainId: 97 } }]);
    expect(ok(responses[0])).toEqual({ linked: true });
    expect(await readLink()).toMatchObject({ address, chainId: 97 });
  });

  test("a bad address is BAD_REQUEST and leaves no link", async () => {
    const { responses } = await talk([{ id: "l2", type: "link", payload: { address: "nope", chainId: 97 } }]);
    expect(responses[0]).toMatchObject({ id: "l2", ok: false, error: { code: "BAD_REQUEST" } });
    expect(await readLink()).toBeUndefined();
  });

  test("a payload that is not an object is BAD_REQUEST", async () => {
    const { responses } = await talk([{ id: "l3", type: "link", payload: "0xabc" }]);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
  });

  test("unlink removes it and is fine when there is nothing to remove", async () => {
    const { responses } = await talk([
      { id: "u1", type: "link", payload: { address: "0x2222222222222222222222222222222222222222", chainId: 97 } },
      { id: "u2", type: "unlink" },
      { id: "u3", type: "unlink" },
    ]);
    expect(ok(responses[1])).toEqual({ linked: false });
    expect(ok(responses[2])).toEqual({ linked: false });
    expect(await readLink()).toBeUndefined();
  });
});

describe("answering every request", () => {
  test("one response per request, in order, each with its own id", async () => {
    // An extension waiting on an id that never comes hangs with nothing to
    // show the person, so this is the property that matters most.
    const ids = ["r1", "r2", "r3", "r4"];
    const { responses } = await talk([
      { id: "r1", type: "hello" },
      { id: "r2", type: "listAgents" },
      { id: "r3", type: "nonsense" },
      { id: "r4", type: "unlink" },
    ]);
    expect(responses.map((r) => r.id)).toEqual(ids);
  });

  test("an unknown type is BAD_REQUEST", async () => {
    const { responses } = await talk([{ id: "x1", type: "teleport" }]);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect((responses[0] as { error: { message: string } }).error.message).toContain("teleport");
  });

  test("every request type in the contract is implemented, so nothing is a placeholder", async () => {
    // This replaces a test that checked the opposite. The placeholder list
    // emptied out one milestone at a time, sendSession with M6, the request
    // types with M7, revokeSession with M8, and now the useful assertion is
    // that the contract's whole surface answers on its own terms rather than
    // naming a milestone.
    const types = [
      "hello",
      "listAgents",
      "link",
      "unlink",
      "sendSession",
      "revokeSession",
      "listRequests",
      "answerRequest",
    ];
    const { responses } = await talk(types.map((type, i) => ({ id: `impl-${i}`, type })));
    expect(responses).toHaveLength(types.length);
    for (const response of responses) {
      if (response.ok) continue;
      // A refusal is fine here, since most of these are being called with no
      // payload. What must not appear is a milestone placeholder.
      expect(response.error.message).not.toMatch(/does not implement/);
      expect(response.error.message).not.toMatch(/\bM[1-8]\b/);
    }
  });

  test("the request types are implemented now, and answer on their own terms", async () => {
    const { responses } = await talk([
      { id: "q1", type: "listRequests" },
      { id: "q2", type: "answerRequest" },
      { id: "q3", type: "answerRequest", payload: { id: "nope", decision: "approve" } },
    ]);
    // Nothing has asked for anything, so the list is empty rather than missing.
    expect(ok(responses[0])).toEqual({ requests: [] });
    expect(responses[1]).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    // An answer to a request that does not exist is NOT_FOUND, not INTERNAL.
    expect(responses[2]).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("sendSession is implemented, so an empty one is a BAD_REQUEST about its shape", async () => {
    const { responses } = await talk([{ id: "n4", type: "sendSession" }]);
    expect(responses[0]).toMatchObject({ ok: false, error: { code: "BAD_REQUEST" } });
    expect((responses[0] as { error: { message: string } }).error.message).toContain("object");
  });

  test("a request with no type is BAD_REQUEST, with its id", async () => {
    const { responses } = await talk([{ id: "t1" }]);
    expect(responses[0]).toMatchObject({ id: "t1", ok: false, error: { code: "BAD_REQUEST" } });
  });

  test("a request with no id is logged and skipped, because there is nothing to answer", async () => {
    const { responses, stderr } = await talk([{ type: "hello" }]);
    expect(responses).toEqual([]);
    expect(stderr.join("\n")).toContain("no string id");
  });

  test("a malformed frame is skipped and the next request still gets an answer", async () => {
    const bad = Buffer.alloc(4 + 5);
    bad.writeUInt32LE(5, 0);
    bad.write("{not!", 4, "utf8");
    const chunks: Buffer[] = [];
    const stderr: string[] = [];
    await runNativeHost({
      input: (async function* () {
        yield bad;
        yield encodeFrame({ id: "after", type: "hello" });
      })(),
      write: (b) => void chunks.push(Buffer.from(b)),
      log: (l) => void stderr.push(l),
    });
    const decoder = new FrameDecoder();
    const got = chunks.flatMap((c) => decoder.push(c));
    const ids = got.map((f) => (f.ok ? (f.value as { id?: string }).id : undefined)).filter(Boolean);
    expect(ids).toContain("after");
    expect(stderr.join("\n")).toContain("ignoring a frame");
  });

  test("a length prefix the host will not believe stops it without throwing", async () => {
    // A desynced stream cannot be answered: the id of whatever was asked is
    // part of what was lost. Stopping is the honest response.
    const absurd = Buffer.alloc(4);
    absurd.writeUInt32LE(MAX_INBOUND_BYTES + 1, 0);
    const stderr: string[] = [];
    await runNativeHost({
      input: (async function* () {
        yield absurd;
      })(),
      write: () => {},
      log: (l) => void stderr.push(l),
    });
    expect(stderr.join("\n")).toContain("stopping");
  });
});

describe("key material never reaches the wire or a log", () => {
  test("a handover key in a request is in nothing the host writes", async () => {
    // This is the unit level half of G8. The key below is a throwaway shape,
    // never used to sign anything.
    const key = `0x${"ab".repeat(32)}`;
    const { wire, stderr } = await talk([
      { id: "k1", type: "sendSession", payload: { name: "bot", sessionPrivateKey: key } },
      { id: "k2", type: "link", payload: { address: key, chainId: 97 } },
      { id: "k3", type: "hello" },
    ]);
    expect(wire).not.toContain(key);
    expect(wire).not.toContain("abab");
    const logs = stderr.join("\n");
    expect(logs).not.toContain(key);
    expect(logs).not.toContain("abab");
  });
});
