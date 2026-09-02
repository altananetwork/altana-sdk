/**
 * Session persistence (issue #58).
 *
 * The old docs said "persist the Session object verbatim" — which threw on
 * bigint spend limits, wrote the raw session key into storage, and dropped
 * the signing function. serializeSession/deserializeSession are the
 * replacement: the secret never enters the serialized form, values (not
 * bytes) round-trip losslessly, and a wrong key is refused at restore time
 * instead of failing opaquely at execute.
 */
import { describe, expect, test } from "bun:test";
import { generatePrivateKey } from "viem/accounts";
import type { Address } from "viem";
import {
  deserializeSession,
  serializeSession,
  type Session,
} from "./sessions.js";
import type { GrantSessionResult } from "./sessions.js";
import { createPrivateKeySigner, signerFromPrivateKey, hasRawPrivateKey, type Signer } from "./signer.js";
import { sessionKeyHash } from "./erc1271.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDT: Address = "0x2222222222222222222222222222222222222222";

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {
      calls: [{ to: USDT, signature: "transfer(address,uint256)" }, { to: WALLET }],
      spend: [
        { limit: 50n * 10n ** 18n, period: "day", token: USDT },
        { limit: 10n ** 16n, period: "hour" },
      ],
    },
    expiry: 1_900_000_000,
  };
}

describe("serializeSession / deserializeSession", () => {
  test("round-trips values losslessly and preserves the on-chain key hash", () => {
    const signer = createPrivateKeySigner();
    const session = makeSession(signer);

    // Through actual JSON — the storage medium the docs point at.
    const stored = JSON.parse(JSON.stringify(serializeSession(session)));
    const restored = deserializeSession(stored, signer);

    expect(restored.permissions).toEqual(session.permissions);
    expect(restored.expiry).toBe(session.expiry);
    expect(restored.walletAddress).toBe(session.walletAddress);
    expect(typeof restored.permissions.spend?.[0]?.limit).toBe("bigint");
    // The invariant the whole feature protects: same key hash as the grant.
    expect(sessionKeyHash(restored)).toBe(sessionKeyHash(session));
  });

  test("the serialized form contains no key material", () => {
    const pk = generatePrivateKey();
    const signer = signerFromPrivateKey(pk);
    const json = JSON.stringify(serializeSession(makeSession(signer)));
    expect(json).not.toContain(pk.slice(2));
    expect(json).not.toContain("_privateKey");
    expect(json).not.toContain("signDigest");
  });

  test("serializing a GrantSessionResult drops transactionHash", () => {
    const signer = createPrivateKeySigner();
    const granted: GrantSessionResult = { ...makeSession(signer), transactionHash: "0xdead" };
    expect("transactionHash" in serializeSession(granted)).toBe(false);
  });

  test("refuses a signer that doesn't match the stored session", () => {
    const session = makeSession(createPrivateKeySigner());
    const stored = serializeSession(session);
    const wrongSigner = createPrivateKeySigner();
    expect(() => deserializeSession(stored, wrongSigner)).toThrow(/does not\s+match the stored session/);
  });

  test("accepts re-cased stored hex and heals publicKey to the signer's casing", () => {
    const signer = createPrivateKeySigner();
    const stored = serializeSession(makeSession(signer));
    const recased = { ...stored, publicKey: stored.publicKey.toUpperCase().replace("0X", "0x") as never };
    const restored = deserializeSession(recased, signer);
    expect(restored.publicKey).toBe(signer.publicKey);
  });

  test("rejects non-decimal spend limits with a field-naming error", () => {
    const signer = createPrivateKeySigner();
    const stored = serializeSession(makeSession(signer));
    const corrupted = {
      ...stored,
      permissions: { spend: [{ limit: "1e18", period: "day" as const }] },
    };
    expect(() => deserializeSession(corrupted, signer)).toThrow(/not a\s+decimal string/);
  });

  test("tolerates unknown extra fields on the stored object", () => {
    const signer = createPrivateKeySigner();
    const stored = { ...serializeSession(makeSession(signer)), name: "agent-1", createdAt: "2026-09-01" };
    expect(() => deserializeSession(stored, signer)).not.toThrow();
  });
});

describe("signer key hygiene (issue #58)", () => {
  test("JSON round-trip of a signer no longer captures the private key", () => {
    const pk = generatePrivateKey();
    const signer = signerFromPrivateKey(pk);
    expect(Object.keys(signer)).not.toContain("_privateKey");
    expect(JSON.stringify(signer)).not.toContain(pk.slice(2));
  });

  test("internal raw-key access still works on the non-enumerable field", () => {
    const pk = generatePrivateKey();
    const signer = signerFromPrivateKey(pk);
    expect(hasRawPrivateKey(signer)).toBe(true);
    expect(signer._privateKey).toBe(pk);
  });

  test("a deserialized session still signs (the session signing path reads the raw key)", async () => {
    const signer = createPrivateKeySigner();
    const restored = deserializeSession(serializeSession(makeSession(signer)), signer);
    // sessionKeyHash derives from the signer the same way the signing path
    // does; a full signErc1271 needs a live account, so pin the key linkage.
    expect(hasRawPrivateKey(restored.signer)).toBe(true);
    expect(await restored.signer.signDigest(`0x${"11".repeat(32)}`)).toMatch(/^0x/);
  });
});
