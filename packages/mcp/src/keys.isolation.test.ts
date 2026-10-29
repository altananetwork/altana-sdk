/**
 * Keeping a test run out of somebody's real key storage.
 *
 * An end-to-end test that imported a session into the developer's actual login
 * keychain would leave real entries behind, and on macOS it can raise an access
 * prompt that no unattended run can answer. So ALTANA_KEY_STORE and ALTANA_HOME
 * redirect both stores.
 *
 * These assert the redirect actually happens, by writing and then looking in the
 * temporary file. Nothing here touches the OS keychain, which is the point.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

let dir: string;
let savedStore: string | undefined;
let savedHome: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "altana-keys-test-"));
  savedStore = process.env.ALTANA_KEY_STORE;
  savedHome = process.env.ALTANA_HOME;
  process.env.ALTANA_KEY_STORE = `file:${join(dir, "keys.json")}`;
  process.env.ALTANA_HOME = dir;
});

afterEach(async () => {
  if (savedStore === undefined) delete process.env.ALTANA_KEY_STORE;
  else process.env.ALTANA_KEY_STORE = savedStore;
  if (savedHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = savedHome;
  await rm(dir, { recursive: true, force: true });
});

describe("a redirected key store", () => {
  test("writes a session key to the file, not the keychain", async () => {
    const { setSessionKey } = await import("./keys.js");
    await setSessionKey("agent-under-test", KEY);

    const raw = JSON.parse(await readFile(join(dir, "keys.json"), "utf8"));
    expect(raw.sessions).toHaveLength(1);
    expect(raw.sessions[0].name).toBe("agent-under-test");
  });

  test("reads the key back", async () => {
    const { setSessionKey, getSessionKey } = await import("./keys.js");
    await setSessionKey("agent-under-test", KEY);
    const resolved = await getSessionKey("agent-under-test");
    expect(resolved.privateKey).toBe(KEY);
    expect(resolved.source).toBe("file");
  });

  test("reports a key it does not have, naming the file rather than the keychain", async () => {
    const { getSessionKey } = await import("./keys.js");
    await expect(getSessionKey("never-imported")).rejects.toThrow(/keys\.json/);
  });

  test("deletes a key", async () => {
    const { setSessionKey, deleteSessionKey, sessionKeyExists } = await import("./keys.js");
    await setSessionKey("agent-under-test", KEY);
    expect(await sessionKeyExists("agent-under-test")).toBe(true);
    await deleteSessionKey("agent-under-test");
    expect(await sessionKeyExists("agent-under-test")).toBe(false);
  });

  test("keeps wallet and session keys in separate buckets, as the keychain does", async () => {
    const { setSessionKey, setWalletKey } = await import("./keys.js");
    await setSessionKey("same-name", KEY);
    await setWalletKey("same-name", KEY);
    const raw = JSON.parse(await readFile(join(dir, "keys.json"), "utf8"));
    expect(raw.sessions).toHaveLength(1);
    expect(raw.wallets).toHaveLength(1);
  });

  test("replaces a key of the same name rather than duplicating it", async () => {
    const { setSessionKey } = await import("./keys.js");
    await setSessionKey("agent-under-test", KEY);
    await setSessionKey("agent-under-test", KEY);
    const raw = JSON.parse(await readFile(join(dir, "keys.json"), "utf8"));
    expect(raw.sessions).toHaveLength(1);
  });
});

describe("a malformed override is refused rather than guessed at", () => {
  test("rejects a value that is not file:", async () => {
    process.env.ALTANA_KEY_STORE = "/tmp/keys.json";
    const { setSessionKey } = await import("./keys.js");
    await expect(setSessionKey("x", KEY)).rejects.toThrow(/must look like file:/);
  });

  test("rejects file: with nothing after it", async () => {
    process.env.ALTANA_KEY_STORE = "file:";
    const { setSessionKey } = await import("./keys.js");
    await expect(setSessionKey("x", KEY)).rejects.toThrow(/no path after it/);
  });
});

describe("session metadata follows ALTANA_HOME", () => {
  test("is written into the temporary directory", async () => {
    const { saveSession, getSession } = await import("./sessions.js");
    await saveSession({
      name: "agent-under-test",
      walletName: "imported",
      walletAddress: "0x6Ad4FBd1a39f9BC5476F0d6A77e71681ea7dEc52",
      publicKey: "0x04aabbcc",
      permissions: { spend: [{ limit: "1", period: "day" }] },
      expiry: 2_000_000_000,
      createdAt: "2026-10-06T00:00:00.000Z",
    });

    const raw = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
    expect(raw.sessions[0].name).toBe("agent-under-test");
    expect((await getSession("agent-under-test")).walletName).toBe("imported");
  });
});
