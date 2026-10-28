import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { signerFromPrivateKey, type SerializedSession } from "@altananetwork/sdk";
import { getSessionKey } from "./keys.js";
import { listSessions } from "./sessions.js";
import {
  parseHandoff,
  sessionFromHandoff,
  storeHandedOverSession,
  SessionHandoverError,
  SessionNameTakenError,
  type SessionHandoff,
} from "./storeSession.js";

let home: string;
const realHome = process.env.ALTANA_HOME;
const realStore = process.env.ALTANA_KEY_STORE;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-store-"));
  process.env.ALTANA_HOME = home;
  // The file store, so no test writes into the real keychain. S1 established
  // that the keychain itself works across processes; this is only isolation.
  process.env.ALTANA_KEY_STORE = `file:${join(home, "keys.json")}`;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realHome;
  if (realStore === undefined) delete process.env.ALTANA_KEY_STORE;
  else process.env.ALTANA_KEY_STORE = realStore;
  await rm(home, { recursive: true, force: true });
});

const WALLET = "0x1111111111111111111111111111111111111111";

/**
 * A handover the extension could really have sent.
 *
 * Built locally with no chain involved: what makes a session valid to store is
 * that its publicKey is the public half of the key that comes with it, which is
 * exactly what deserializeSession checks.
 */
function handoff(overrides: Partial<SessionHandoff> & { expiry?: number } = {}): {
  handoff: SessionHandoff;
  privateKey: `0x${string}`;
  session: SerializedSession;
} {
  const privateKey = generatePrivateKey();
  const signer = signerFromPrivateKey(privateKey);
  const session: SerializedSession = {
    walletAddress: (overrides.walletAddress ?? WALLET) as `0x${string}`,
    publicKey: signer.publicKey,
    permissions: {
      calls: [{ to: "0x2222222222222222222222222222222222222222" }],
      spend: [{ limit: "1000000000000000", period: "day" }],
    },
    expiry: overrides.expiry ?? Math.floor(Date.now() / 1000) + 604800,
  };
  return {
    privateKey,
    session,
    handoff: {
      name: "trading-bot",
      chainId: 97,
      walletAddress: session.walletAddress,
      serializedSession: JSON.stringify(session),
      sessionPrivateKey: privateKey,
      ...overrides,
    } as SessionHandoff,
  };
}

describe("parseHandoff", () => {
  test("accepts the contract's shape", () => {
    const { handoff: h } = handoff();
    const parsed = parseHandoff(h);
    expect(parsed.name).toBe("trading-bot");
    expect(parsed.chainId).toBe(97);
    expect(parsed.walletAddress).toBe(WALLET);
  });

  test("refuses a payload that is not an object", () => {
    expect(() => parseHandoff("nope")).toThrow(SessionHandoverError);
    expect(() => parseHandoff([1, 2])).toThrow(SessionHandoverError);
    expect(() => parseHandoff(null)).toThrow(SessionHandoverError);
  });

  test("names each missing field", () => {
    const { handoff: h } = handoff();
    expect(() => parseHandoff({ ...h, name: "" })).toThrow(/no name/);
    expect(() => parseHandoff({ ...h, chainId: 0 })).toThrow(/chainId/);
    expect(() => parseHandoff({ ...h, walletAddress: "0xshort" })).toThrow(/walletAddress/);
    expect(() => parseHandoff({ ...h, serializedSession: "" })).toThrow(/serializedSession/);
  });

  test("complains about a bad key without ever quoting it", () => {
    // A validator that echoes its input is how a key reaches a log file.
    const bad = "0xdeadbeef";
    try {
      parseHandoff({ ...handoff().handoff, sessionPrivateKey: bad });
      throw new Error("should have refused");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("sessionPrivateKey");
      expect(message).not.toContain(bad);
    }
  });

  test("trims, because a value copied out of a browser arrives with whitespace", () => {
    const { handoff: h, privateKey } = handoff();
    const parsed = parseHandoff({ ...h, name: "  bot  ", sessionPrivateKey: `  ${privateKey}  ` });
    expect(parsed.name).toBe("bot");
    expect(parsed.sessionPrivateKey).toBe(privateKey);
  });
});

describe("sessionFromHandoff", () => {
  test("parses the serialized half", () => {
    const { handoff: h, session } = handoff();
    expect(sessionFromHandoff(parseHandoff(h))).toEqual(session);
  });

  test("refuses one whose wallet disagrees with the handover's", () => {
    // A mispaired message. Storing it would make a session that signs for a
    // wallet the extension is not showing.
    const { handoff: h } = handoff();
    const mismatched = { ...h, walletAddress: "0x3333333333333333333333333333333333333333" };
    expect(() => sessionFromHandoff(parseHandoff(mismatched))).toThrow(/the same wallet/);
  });

  test("refuses serializedSession that is not JSON, or is missing a field", () => {
    const { handoff: h } = handoff();
    expect(() => sessionFromHandoff({ ...parseHandoff(h), serializedSession: "{oops" })).toThrow(/not JSON/);
    for (const missing of ["publicKey", "expiry", "permissions"] as const) {
      const session = JSON.parse(h.serializedSession);
      delete session[missing];
      expect(() =>
        sessionFromHandoff({ ...parseHandoff(h), serializedSession: JSON.stringify(session) }),
      ).toThrow(new RegExp(missing));
    }
  });
});

describe("storeHandedOverSession", () => {
  test("writes the metadata and the key, and returns nothing secret", async () => {
    const { handoff: h, privateKey, session } = handoff();
    const stored = await storeHandedOverSession({
      sessionName: h.name,
      session,
      privateKey,
    });

    expect(stored.sessionName).toBe("trading-bot");
    expect(stored.walletAddress).toBe(WALLET);
    expect(stored.expired).toBe(false);
    // Whatever comes back out of here may be logged or sent over the wire.
    expect(JSON.stringify(stored)).not.toContain(privateKey.slice(2));

    const sessions = await listSessions();
    expect(sessions.map((s) => s.name)).toEqual(["trading-bot"]);
    expect(sessions[0]).toMatchObject({
      walletName: "imported",
      walletAddress: WALLET,
      publicKey: session.publicKey,
      expiry: session.expiry,
    });

    // The key is retrievable by name, which is what session_execute needs.
    expect((await getSessionKey("trading-bot")).privateKey).toBe(privateKey);
  });

  test("stores exactly what the sessions file format expects", async () => {
    const { handoff: h, privateKey, session } = handoff();
    await storeHandedOverSession({ sessionName: h.name, session, privateKey });
    const file = JSON.parse(await readFile(join(home, "sessions.json"), "utf8"));
    expect(file.v).toBe(1);
    expect(file.sessions).toHaveLength(1);
    expect(Object.keys(file.sessions[0]).sort()).toEqual(
      ["createdAt", "expiry", "name", "permissions", "publicKey", "walletAddress", "walletName"].sort(),
    );
    // No key material in the metadata file, ever.
    expect(JSON.stringify(file)).not.toContain(privateKey.slice(2));
  });

  test("refuses a key that does not belong to the session, and writes nothing", async () => {
    // Porto derives a key hash from the permissions and the expiry, so a
    // session rebuilt from mismatched halves is a key the relay has never heard
    // of. Caught here rather than as "key hash unknown" at execute time.
    const { session } = handoff();
    const strangerKey = generatePrivateKey();
    await expect(
      storeHandedOverSession({ sessionName: "bot", session, privateKey: strangerKey }),
    ).rejects.toThrow(SessionHandoverError);

    expect(await listSessions()).toEqual([]);
    await expect(getSessionKey("bot")).rejects.toThrow();
  });

  test("refuses a name that is taken, and leaves the first one alone", async () => {
    const first = handoff();
    await storeHandedOverSession({
      sessionName: "bot",
      session: first.session,
      privateKey: first.privateKey,
    });

    const second = handoff();
    await expect(
      storeHandedOverSession({
        sessionName: "bot",
        session: second.session,
        privateKey: second.privateKey,
      }),
    ).rejects.toThrow(SessionNameTakenError);

    // The original is untouched: overwriting would quietly repoint an agent's
    // authority at a different permission.
    expect((await getSessionKey("bot")).privateKey).toBe(first.privateKey);
    expect((await listSessions())[0]?.publicKey).toBe(first.session.publicKey);
  });

  test("stores an already expired session but says it is expired", async () => {
    const { privateKey, session } = handoff({ expiry: Math.floor(Date.now() / 1000) - 60 });
    const stored = await storeHandedOverSession({ sessionName: "old", session, privateKey });
    expect(stored.expired).toBe(true);
    expect(stored.secondsLeft).toBeUndefined();
    expect((await listSessions()).map((s) => s.name)).toEqual(["old"]);
  });

  test("reports how long is left on a live one", async () => {
    const { privateKey, session } = handoff({ expiry: Math.floor(Date.now() / 1000) + 3600 });
    const stored = await storeHandedOverSession({ sessionName: "live", session, privateKey });
    expect(stored.expired).toBe(false);
    expect(stored.secondsLeft).toBeGreaterThan(3500);
  });
});
