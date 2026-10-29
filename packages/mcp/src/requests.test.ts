import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerRequest,
  createRequest,
  deleteRequest,
  expireRequest,
  hasExpired,
  listPendingRequests,
  readRequest,
  requestsDir,
  RequestError,
  waitForAnswer,
  type PermissionAsk,
} from "./requests.js";

let home: string;
const realHome = process.env.ALTANA_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-requests-"));
  process.env.ALTANA_HOME = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

const ASK: PermissionAsk = {
  name: "trading-bot",
  chainId: 97,
  spend: [{ limit: "1000000000000000", period: "day" }],
  expirySeconds: 604800,
  reason: "I want to rebalance the position you asked about.",
};

const CLIENT = { name: "claude-code", version: "2.1.312" };

/** No real waiting: a ten minute timeout is not something to prove in real time. */
const instantly = async () => {};

describe("createRequest", () => {
  test("writes the contract's shape, 0600 in a 0700 directory", async () => {
    const request = await createRequest({ id: "abc", client: CLIENT, ask: ASK });
    expect(request).toMatchObject({ v: 1, id: "abc", status: "pending", answer: null, ask: ASK });
    expect(Date.parse(request.createdAt)).not.toBeNaN();
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.parse(request.createdAt));

    const path = join(requestsDir(), "abc.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(requestsDir())).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(request);
  });

  test("the reason travels verbatim, because that sentence is what the person reads", async () => {
    const request = await createRequest({ id: "r", client: CLIENT, ask: ASK });
    expect(request.ask.reason).toBe("I want to rebalance the position you asked about.");
  });

  test("leaves no temporary file, because the host watches this directory", async () => {
    await createRequest({ id: "abc", client: CLIENT, ask: ASK });
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(requestsDir())).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("listPendingRequests", () => {
  test("no directory is an empty list", async () => {
    expect(await listPendingRequests()).toEqual([]);
  });

  test("returns pending ones, oldest first", async () => {
    await createRequest({ id: "second", client: CLIENT, ask: ASK });
    await Bun.sleep(5);
    await createRequest({ id: "third", client: CLIENT, ask: ASK });
    expect((await listPendingRequests()).map((r) => r.id)).toEqual(["second", "third"]);
  });

  test("leaves out anything already answered", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    await createRequest({ id: "b", client: CLIENT, ask: ASK });
    await answerRequest({ id: "b", decision: "reject" });
    expect((await listPendingRequests()).map((r) => r.id)).toEqual(["a"]);
  });

  test("leaves out one that has run out of time even though its file says pending", async () => {
    // The file is written once and time keeps moving, so the status on disk is
    // a claim to check against the clock. Otherwise the extension shows the
    // person a request to approve that the agent gave up on minutes ago.
    await createRequest({ id: "stale", client: CLIENT, ask: ASK, timeoutSeconds: 1 });
    expect(await listPendingRequests()).toHaveLength(1);
    expect(await listPendingRequests(Date.now() + 2000)).toEqual([]);
  });

  test("one unreadable file does not hide the others", async () => {
    await mkdir(requestsDir(), { recursive: true });
    await writeFile(join(requestsDir(), "broken.json"), "{ not json");
    await createRequest({ id: "good", client: CLIENT, ask: ASK });
    expect((await listPendingRequests()).map((r) => r.id)).toEqual(["good"]);
  });
});

describe("answerRequest", () => {
  test("approve records the session name", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    const answered = await answerRequest({ id: "a", decision: "approve", sessionName: "trading-bot" });
    expect(answered.status).toBe("approved");
    expect(answered.answer).toEqual({ sessionName: "trading-bot" });
    expect((await readRequest("a"))?.status).toBe("approved");
  });

  test("reject records no session", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    const answered = await answerRequest({ id: "a", decision: "reject" });
    expect(answered.status).toBe("rejected");
    expect(answered.answer).toBeNull();
  });

  test("an approval with no session name is refused", async () => {
    // An approved request with no permission behind it would tell the agent yes
    // and then fail at session_execute.
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    await expect(answerRequest({ id: "a", decision: "approve" })).rejects.toThrow(/which session/);
  });

  test("answering twice is refused, which is how two hosts racing settle it", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    await answerRequest({ id: "a", decision: "approve", sessionName: "bot" });
    await expect(
      answerRequest({ id: "a", decision: "reject" }),
    ).rejects.toThrow(/already approved/);
    // The first answer stands rather than being overwritten by the second.
    expect((await readRequest("a"))?.answer).toEqual({ sessionName: "bot" });
  });

  test("answering one that has expired marks it expired and says so", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK, timeoutSeconds: 1 });
    await expect(
      answerRequest({ id: "a", decision: "approve", sessionName: "bot", now: Date.now() + 2000 }),
    ).rejects.toThrow(/expired before it was answered/);
    // Written down, so the agent's own wait ends with the word the person saw.
    expect((await readRequest("a"))?.status).toBe("expired");
  });

  test("answering one that does not exist says so", async () => {
    await expect(answerRequest({ id: "ghost", decision: "reject" })).rejects.toThrow(RequestError);
  });
});

describe("waitForAnswer", () => {
  test("returns as soon as it is approved", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    const waiting = waitForAnswer({ id: "a", pollMs: 5 });
    await Bun.sleep(20);
    await answerRequest({ id: "a", decision: "approve", sessionName: "trading-bot" });
    expect(await waiting).toEqual({ status: "approved", sessionName: "trading-bot" });
  });

  test("returns when it is rejected", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    const waiting = waitForAnswer({ id: "a", pollMs: 5 });
    await Bun.sleep(20);
    await answerRequest({ id: "a", decision: "reject" });
    expect(await waiting).toEqual({ status: "rejected" });
  });

  test("gives up on its own deadline and writes that down", async () => {
    // The property that matters most: an agent in here is a conversation
    // stopped mid sentence, so every path has to end.
    await createRequest({ id: "a", client: CLIENT, ask: ASK, timeoutSeconds: 600 });
    let clock = Date.now();
    const outcome = await waitForAnswer({
      id: "a",
      timeoutSeconds: 600,
      sleep: async () => {
        clock += 60_000;
      },
      now: () => clock,
    });
    expect(outcome).toEqual({ status: "expired" });
    expect((await readRequest("a"))?.status).toBe("expired");
  });

  test("ends rather than hanging if the file is deleted under it", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    const waiting = waitForAnswer({ id: "a", pollMs: 5 });
    await Bun.sleep(20);
    await deleteRequest("a");
    // Treated as a refusal: the agent's answer is the same either way, that it
    // may not act.
    expect(await waiting).toEqual({ status: "rejected" });
  });

  test("returns at once for a request that was already answered", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    await answerRequest({ id: "a", decision: "approve", sessionName: "bot" });
    expect(await waitForAnswer({ id: "a", sleep: instantly })).toEqual({
      status: "approved",
      sessionName: "bot",
    });
  });
});

describe("hasExpired and expireRequest", () => {
  test("hasExpired reads the deadline off the file", async () => {
    const request = await createRequest({ id: "a", client: CLIENT, ask: ASK, timeoutSeconds: 10 });
    expect(hasExpired(request)).toBe(false);
    expect(hasExpired(request, Date.now() + 11_000)).toBe(true);
  });

  test("expireRequest only touches a pending one", async () => {
    await createRequest({ id: "a", client: CLIENT, ask: ASK });
    await answerRequest({ id: "a", decision: "approve", sessionName: "bot" });
    await expireRequest("a");
    expect((await readRequest("a"))?.status).toBe("approved");
  });
});
