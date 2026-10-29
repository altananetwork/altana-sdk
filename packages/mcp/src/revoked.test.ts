import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRevoked,
  markRevoked,
  pruneOldMarkers,
  readRevoked,
  revokedDir,
  revokedMessage,
  PRUNE_AFTER_DAYS,
} from "./revoked.js";

let home: string;
const realHome = process.env.ALTANA_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-revoked-"));
  process.env.ALTANA_HOME = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

describe("markRevoked", () => {
  test("writes the contract's shape at 0600 in a 0700 directory", async () => {
    const marker = await markRevoked({ name: "trading-bot", by: "extension" });
    expect(marker).toMatchObject({ v: 1, name: "trading-bot", by: "extension" });
    expect(Date.parse(marker.revokedAt)).not.toBeNaN();

    const path = join(revokedDir(), "trading-bot.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(revokedDir())).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(marker);
  });

  test("records which side did it, because the agent's answer differs", async () => {
    await markRevoked({ name: "a", by: "extension" });
    await markRevoked({ name: "b", by: "agent" });
    expect((await readRevoked("a"))?.by).toBe("extension");
    expect((await readRevoked("b"))?.by).toBe("agent");
  });

  test("a name with a slash or a dot dot cannot write outside the directory", async () => {
    // The name arrives from a request payload, so it reaches a path from
    // outside this process.
    await markRevoked({ name: "../escape", by: "extension" });
    await markRevoked({ name: "a/b", by: "extension" });
    const files = await readdir(revokedDir());
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).not.toContain("/");
    // And it still round trips, which is the other half of being correct.
    expect((await readRevoked("../escape"))?.name).toBe("../escape");
    expect((await readRevoked("a/b"))?.name).toBe("a/b");
  });

  test("leaves no temporary file behind", async () => {
    await markRevoked({ name: "a", by: "extension" });
    expect((await readdir(revokedDir())).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readRevoked", () => {
  test("nothing for a name that was never revoked", async () => {
    expect(await readRevoked("never")).toBeUndefined();
  });

  test("nothing for a marker past its keeping time", async () => {
    await mkdir(revokedDir(), { recursive: true });
    const old = new Date(Date.now() - (PRUNE_AFTER_DAYS + 1) * 86400_000).toISOString();
    await writeFile(
      join(revokedDir(), "stale.json"),
      JSON.stringify({ v: 1, name: "stale", revokedAt: old, by: "extension" }),
    );
    expect(await readRevoked("stale")).toBeUndefined();
  });

  test("a malformed marker reads as nothing rather than throwing", async () => {
    await mkdir(revokedDir(), { recursive: true });
    await writeFile(join(revokedDir(), "broken.json"), "{ not json");
    expect(await readRevoked("broken")).toBeUndefined();
  });
});

describe("pruneOldMarkers", () => {
  test("removes the stale and the unreadable, keeps the fresh", async () => {
    await markRevoked({ name: "fresh", by: "extension" });
    await mkdir(revokedDir(), { recursive: true });
    const old = new Date(Date.now() - (PRUNE_AFTER_DAYS + 1) * 86400_000).toISOString();
    await writeFile(
      join(revokedDir(), "stale.json"),
      JSON.stringify({ v: 1, name: "stale", revokedAt: old, by: "extension" }),
    );
    await writeFile(join(revokedDir(), "broken.json"), "{ not json");

    // A file that will not parse can never give a better answer than its
    // absence would, so it goes too.
    expect(await pruneOldMarkers()).toBe(2);
    expect(await readdir(revokedDir())).toEqual(["fresh.json"]);
  });

  test("an empty or missing directory is not an error", async () => {
    expect(await pruneOldMarkers()).toBe(0);
  });
});

describe("clearRevoked", () => {
  test("forgets a marker, so a name can be used again", async () => {
    await markRevoked({ name: "reused", by: "extension" });
    await clearRevoked("reused");
    expect(await readRevoked("reused")).toBeUndefined();
    await clearRevoked("reused");
  });
});

describe("revokedMessage", () => {
  test("says who took it away and that retrying is not the answer", async () => {
    // The whole point of the marker: an agent that reads this should tell the
    // person and stop, not go looking for another way through.
    const marker = await markRevoked({ name: "trading-bot", by: "extension" });
    const message = revokedMessage(marker);
    expect(message).toContain("trading-bot");
    expect(message).toContain("was revoked");
    expect(message).toContain("the person who owns the wallet");
    expect(message).toContain(marker.revokedAt);
    expect(message).toContain("not a fault to retry");
    expect(message).toContain("request_permission");
  });

  test("names the agent when the agent did it", async () => {
    const marker = await markRevoked({ name: "self", by: "agent" });
    expect(revokedMessage(marker)).toContain("by this agent");
  });
});
