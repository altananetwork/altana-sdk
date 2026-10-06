/**
 * Taking a session from the environment, which is how a key reaches an agent
 * without passing through its chat.
 *
 * The route matters as much as the mechanism. Pasting a key into an
 * `import_session` tool call sends it to whichever model provider the agent runs
 * on, so the key is handed to the process instead. These assert the parsing, the
 * refusals, and that nothing is written down unless asked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  keyHashForSessionOrKey,
  serializeSession,
  signerFromPrivateKey,
  type SerializedSession,
} from "@altananetwork/sdk";
import { DEFAULT_SESSION_NAME, registerEnvSession, sessionFromEnv } from "./sessionFromEnv.js";
import { forgetHeldSessions, heldSession, heldSessionKey } from "./memorySessions.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WALLET = "0x6Ad4FBd1a39f9BC5476F0d6A77e71681ea7dEc52";
const signer = signerFromPrivateKey(KEY);

const session: SerializedSession = {
  walletAddress: WALLET,
  publicKey: signer.publicKey,
  permissions: {
    calls: [{ to: "0x000000000000000000000000000000000000dEaD" }],
    spend: [{ limit: "1000000000000000", period: "day" }],
  },
  expiry: 2_000_000_000,
};
const SERIALIZED = JSON.stringify(session);

afterEach(() => forgetHeldSessions());

describe("when the environment describes no session", () => {
  test("nothing is loaded, and that is not an error", () => {
    expect(sessionFromEnv({})).toBeUndefined();
    expect(sessionFromEnv({ session: "  ", privateKey: "" })).toBeUndefined();
  });
});

describe("when it describes one", () => {
  test("it is parsed, named and key-hashed", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!;
    expect(found.name).toBe(DEFAULT_SESSION_NAME);
    expect(found.session.walletAddress).toBe(WALLET);
    expect(found.privateKey).toBe(KEY);
    // The hash the relay matches a transaction against.
    expect(found.keyHash).toBe(keyHashForSessionOrKey(signer.publicKey));
  });

  test("a name can be given", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY, name: "trading-bot" })!;
    expect(found.name).toBe("trading-bot");
    expect(found.session.name).toBe("trading-bot");
  });

  test("it records that no admin key exists here, because none does", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!;
    expect(found.session.walletName).toBe("imported");
  });

  test("it round-trips to the same serialized half it came from", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!;
    const { name, walletName, createdAt, ...rest } = found.session;
    expect(rest).toEqual(session);
  });
});

describe("refusing a half or a mismatch, rather than starting without it", () => {
  test("the session without the key", () => {
    expect(() => sessionFromEnv({ session: SERIALIZED })).toThrow(/neither works without the other/);
  });

  test("the key without the session", () => {
    expect(() => sessionFromEnv({ privateKey: KEY })).toThrow(/neither works without the other/);
  });

  test("a key that belongs to a different session", () => {
    // The commonest paste mistake, and the one that would otherwise surface much
    // later as an opaque relay rejection.
    const other = "0x" + "11".repeat(32);
    expect(() => sessionFromEnv({ session: SERIALIZED, privateKey: other })).toThrow(
      /does not belong to that session/,
    );
  });

  test("a session that is not JSON", () => {
    expect(() => sessionFromEnv({ session: "{ not json", privateKey: KEY })).toThrow(/not valid JSON/);
  });

  test("a spend limit given as a number, which cannot hold wei exactly", () => {
    const bad = JSON.stringify({
      ...session,
      permissions: { spend: [{ limit: 1000000000000000, period: "day" }] },
    });
    expect(() => sessionFromEnv({ session: bad, privateKey: KEY })).toThrow(/decimal string/);
  });
});

describe("expiry is reported, not enforced", () => {
  test("a live session reports how long is left", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!;
    expect(found.expired).toBe(false);
    expect(found.secondsLeft).toBeGreaterThan(0);
  });

  test("an expired one still loads, and says so", () => {
    // Loading it and saying it is dead beats refusing to start: the agent can
    // then report the real reason it cannot act.
    const dead = JSON.stringify({ ...session, expiry: 1_000_000_000 });
    const found = sessionFromEnv({ session: dead, privateKey: KEY })!;
    expect(found.expired).toBe(true);
    const lines = registerEnvSession(found).join(" ");
    expect(lines).toMatch(/expired/);
    expect(lines).toMatch(/cannot act/);
  });
});

describe("registering it", () => {
  test("holds it in memory under its name", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY, name: "bot" })!;
    registerEnvSession(found);
    expect(heldSession("bot")?.walletAddress).toBe(WALLET);
    expect(heldSessionKey("bot")).toBe(KEY);
  });

  test("says it is memory only, so nobody assumes it was saved", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!;
    expect(registerEnvSession(found).join(" ")).toMatch(/held in memory only/);
  });

  test("writes nothing down unless persistence was asked for", () => {
    expect(sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!.persist).toBe(false);
    expect(sessionFromEnv({ session: SERIALIZED, privateKey: KEY, persist: "1" })!.persist).toBe(true);
    expect(sessionFromEnv({ session: SERIALIZED, privateKey: KEY, persist: "true" })!.persist).toBe(true);
    // Anything else is not consent.
    expect(sessionFromEnv({ session: SERIALIZED, privateKey: KEY, persist: "yes" })!.persist).toBe(false);
  });

  test("never puts the key in a line meant for the operator's terminal", () => {
    const found = sessionFromEnv({ session: SERIALIZED, privateKey: KEY })!;
    const lines = registerEnvSession(found).join(" ");
    expect(lines).not.toContain(KEY);
    expect(lines).not.toContain(KEY.slice(2));
  });
});
