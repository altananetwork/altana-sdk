/**
 * Importing a session somebody else granted.
 *
 * Every input here is pasted by hand, so the failure modes matter more than the
 * happy path: a session rebuilt with permissions that differ from the grant
 * produces a key hash the relay has never seen, and that surfaces much later as
 * "key hash unknown" at execute time, pointing nowhere near the paste.
 */
import { describe, expect, test } from "bun:test";
import {
  deserializeSession,
  keyHashForSessionOrKey,
  serializeSession,
  signerFromPrivateKey,
  type SerializedSession,
} from "@altananetwork/sdk";
import {
  assertPrivateKey,
  assertSerializedSession,
  expiryState,
  ImportSessionError,
  parseImport,
} from "./importSession.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WALLET = "0x6Ad4FBd1a39f9BC5476F0d6A77e71681ea7dEc52";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

const signer = signerFromPrivateKey(KEY);

const session: SerializedSession = {
  walletAddress: WALLET,
  publicKey: signer.publicKey,
  permissions: {
    calls: [{ to: RECIPIENT }],
    spend: [{ limit: "1000000000000000", period: "day" }],
  },
  expiry: 2_000_000_000,
};

const bundle = JSON.stringify({ v: 1, session, privateKey: KEY });

describe("the happy paths", () => {
  test("a one-blob bundle imports", () => {
    const parsed = parseImport({ bundle });
    expect(parsed.session).toEqual(session);
    expect(parsed.privateKey).toBe(KEY);
  });

  test("the session and the key as separate arguments import", () => {
    const parsed = parseImport({ session: JSON.stringify(session), privateKey: KEY });
    expect(parsed.session).toEqual(session);
    expect(parsed.privateKey).toBe(KEY);
  });

  test("a key given separately wins over one inside the bundle", () => {
    // The explicit argument is the more deliberate of the two.
    const other = "0x" + "11".repeat(32);
    expect(parseImport({ bundle, privateKey: other }).privateKey).toBe(other);
  });

  test("trailing whitespace from a copy and paste is tolerated", () => {
    const parsed = parseImport({ bundle: `${bundle}\n`, privateKey: `  ${KEY}\n` });
    expect(parsed.privateKey).toBe(KEY);
  });

  test("a key pasted without its 0x is accepted, since there is no ambiguity", () => {
    expect(parseImport({ bundle, privateKey: KEY.slice(2) }).privateKey).toBe(KEY);
  });
});

describe("what an imported session rebuilds to", () => {
  test("it reaches the same on-chain key hash as the original grant", () => {
    // This is the whole point of the import. If this drifts, the relay reports
    // an unknown key hash and nothing the agent does works.
    const parsed = parseImport({ bundle });
    const rebuilt = deserializeSession(parsed.session, signerFromPrivateKey(parsed.privateKey));
    const original = deserializeSession(session, signer);
    expect(keyHashForSessionOrKey(rebuilt)).toBe(keyHashForSessionOrKey(original));
  });

  test("it round-trips through serializeSession unchanged", () => {
    const parsed = parseImport({ bundle });
    const rebuilt = deserializeSession(parsed.session, signerFromPrivateKey(parsed.privateKey));
    expect(serializeSession(rebuilt)).toEqual(session);
  });

  test("a key that does not match the session's publicKey is refused", () => {
    // deserializeSession is what catches this, and it must stay caught: a
    // mismatch would otherwise be a silently unusable session.
    const wrongKey = "0x" + "22".repeat(32);
    const parsed = parseImport({ bundle, privateKey: wrongKey });
    expect(() =>
      deserializeSession(parsed.session, signerFromPrivateKey(parsed.privateKey)),
    ).toThrow();
  });
});

describe("refusing a bad paste, with a message that names the problem", () => {
  test("neither form given", () => {
    expect(() => parseImport({})).toThrow(ImportSessionError);
    expect(() => parseImport({})).toThrow(/both session and privateKey/);
  });

  test("the session half pasted on its own, with no key", () => {
    expect(() => parseImport({ bundle: JSON.stringify(session) })).toThrow(
      /session half on its own/,
    );
  });

  test("a bundle that is not JSON", () => {
    expect(() => parseImport({ bundle: "{ not json" })).toThrow(/not valid JSON/);
  });

  test("a bundle from a newer version says to update rather than guessing", () => {
    const future = JSON.stringify({ v: 2, session, privateKey: KEY });
    expect(() => parseImport({ bundle: future })).toThrow(/version 2/);
  });

  test("a truncated private key", () => {
    expect(() => parseImport({ bundle, privateKey: KEY.slice(0, 40) })).toThrow(
      /64 characters/,
    );
  });

  test("a private key that is not hex", () => {
    expect(() => assertPrivateKey("0x" + "z".repeat(64))).toThrow(/32 bytes of hex/);
  });

  test("no private key at all", () => {
    expect(() => assertPrivateKey(undefined)).toThrow(/shows it once/);
  });
});

describe("refusing a malformed session", () => {
  const broken = (patch: Record<string, unknown>) => () =>
    assertSerializedSession({ ...session, ...patch });

  test("a missing wallet address", () => {
    expect(broken({ walletAddress: undefined })).toThrow(/walletAddress/);
  });

  test("a wallet address of the wrong length", () => {
    expect(broken({ walletAddress: "0xabc" })).toThrow(/walletAddress/);
  });

  test("a missing public key", () => {
    expect(broken({ publicKey: undefined })).toThrow(/publicKey/);
  });

  test("an expiry that is not a number", () => {
    expect(broken({ expiry: "2000000000" })).toThrow(/expiry/);
  });

  test("an expiry of zero", () => {
    expect(broken({ expiry: 0 })).toThrow(/expiry/);
  });

  test("no permissions object", () => {
    expect(broken({ permissions: undefined })).toThrow(/permissions/);
  });

  test("a spend limit given as a JSON number, which cannot hold wei exactly", () => {
    expect(
      broken({ permissions: { spend: [{ limit: 1000000000000000, period: "day" }] } }),
    ).toThrow(/decimal string/);
  });

  test("a spend limit that is not digits", () => {
    expect(
      broken({ permissions: { spend: [{ limit: "1e15", period: "day" }] } }),
    ).toThrow(/decimal string/);
  });

  test("an unknown spend period", () => {
    expect(
      broken({ permissions: { spend: [{ limit: "1", period: "fortnight" }] } }),
    ).toThrow(/period must be one of/);
  });

  test("a spend token that is not an address", () => {
    expect(
      broken({ permissions: { spend: [{ limit: "1", period: "day", token: "USDC" }] } }),
    ).toThrow(/token is not an address/);
  });

  test("a call rule that allows nothing", () => {
    expect(broken({ permissions: { calls: [{}] } })).toThrow(/allows nothing/);
  });

  test("a call target that is not an address", () => {
    expect(broken({ permissions: { calls: [{ to: "pancakeswap" }] } })).toThrow(
      /is not an address/,
    );
  });

  test("calls given as an object rather than a list", () => {
    expect(broken({ permissions: { calls: { to: RECIPIENT } } })).toThrow(/not a list/);
  });

  test("a session that is not an object at all", () => {
    expect(() => assertSerializedSession("0xdeadbeef")).toThrow(/not a JSON object/);
    expect(() => assertSerializedSession(null)).toThrow(/not a JSON object/);
    expect(() => assertSerializedSession([session])).toThrow(/not a JSON object/);
  });
});

describe("a session with no permissions at all", () => {
  test("is allowed through, because an unscoped grant is the SDK's own default", () => {
    const unscoped = assertSerializedSession({ ...session, permissions: {} });
    expect(unscoped.permissions).toEqual({});
  });
});

describe("expiry", () => {
  test("reports how long is left", () => {
    expect(expiryState(session, session.expiry - 60)).toEqual({
      expired: false,
      secondsLeft: 60,
    });
  });

  test("reports an already expired session, which is worth saying at import time", () => {
    expect(expiryState(session, session.expiry + 1).expired).toBe(true);
    expect(expiryState(session, session.expiry).expired).toBe(true);
  });
});
