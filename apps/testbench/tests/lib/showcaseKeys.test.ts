import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { keccak256 } from "viem";
import {
  expectedEndState,
  loadShowcaseKeys,
  parseShowcaseKeys,
  type ShowcaseKey,
} from "../../src/lib/showcaseKeys";

const USER = "0xb5D3c1436eE76aCa1ecBd54BB27823488A26FD85" as const;
/** 65 bytes, uncompressed secp256k1, as roles A and B carry. */
const PK65 = `0x04${"ab".repeat(64)}` as const;
/** 64 bytes, flat WebAuthn P256, as the passkey admin key carries. */
const PK64 = `0x${"cd".repeat(64)}` as const;

function entry(over: Record<string, unknown> = {}) {
  return {
    role: "A-valid",
    label: "showcase A",
    demoNote: "the money shot",
    user: USER,
    publicKey: PK65,
    keyStoreKeyId: keccak256(PK65),
    keyType: 2,
    ...over,
  };
}

describe("parseShowcaseKeys", () => {
  test("takes both public key shapes, because the passkey key is 64 bytes", () => {
    const f = parseShowcaseKeys({
      keys: [entry(), entry({ role: "D", publicKey: PK64, keyStoreKeyId: keccak256(PK64), keyType: 1 })],
    });
    expect(f.keys.map((k) => k.role)).toEqual(["A-valid", "D"]);
    expect(f.rejected).toEqual([]);
  });

  test("a keyStoreKeyId that is not keccak256 of the key is rejected, not shown", () => {
    // The two disagreeing means the card reads the mirror for a different key
    // and says "never registered" on stage, which looks like a broken feature.
    const f = parseShowcaseKeys({ keys: [entry({ keyStoreKeyId: keccak256(PK64) })] });
    expect(f.keys).toEqual([]);
    expect(f.rejected[0]!.reason).toContain("not keccak256 of its public key");
  });

  test("the key id is always derived, never trusted from the file", () => {
    const f = parseShowcaseKeys({ keys: [entry({ keyStoreKeyId: undefined })] });
    expect(f.keys[0]!.keyStoreKeyId).toBe(keccak256(PK65));
  });

  test("a malformed wallet or key is rejected with a reason, and the rest survive", () => {
    const f = parseShowcaseKeys({
      keys: [entry({ role: "bad-user", user: "0x123" }), entry({ role: "bad-key", publicKey: "0xdead" }), entry()],
    });
    expect(f.keys.map((k) => k.role)).toEqual(["A-valid"]);
    expect(f.rejected.map((r) => r.role)).toEqual(["bad-user", "bad-key"]);
  });

  test("junk is empty rather than thrown", () => {
    expect(parseShowcaseKeys(null).keys).toEqual([]);
    expect(parseShowcaseKeys({ keys: "no" }).keys).toEqual([]);
    expect(parseShowcaseKeys({ keys: [null, 3] }).keys).toEqual([]);
  });
});

describe("loadShowcaseKeys", () => {
  test("an absent file is not an error: the tab still works by hand", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    expect(await loadShowcaseKeys(fetchImpl as never)).toBeUndefined();
  });

  test("a network failure is not an error either", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    expect(await loadShowcaseKeys(fetchImpl as never)).toBeUndefined();
  });
});

describe("expectedEndState", () => {
  test("a revoked key is expected to read revoked, which is not a failure", () => {
    expect(expectedEndState({ revocationTx: "0xabc" } as ShowcaseKey)).toBe("revoked");
    expect(expectedEndState({} as ShowcaseKey)).toBe("live");
  });
});

describe("the copied public/showcase-keys.json", () => {
  const path = join(__dirname, "..", "..", "public", "showcase-keys.json");

  test("if present, every key in it holds together", () => {
    if (!existsSync(path)) return; // generated from the harness; absent in a clean clone
    const f = parseShowcaseKeys(JSON.parse(readFileSync(path, "utf8")));
    expect(f.rejected).toEqual([]);
    expect(f.keys.length).toBeGreaterThan(0);
    for (const k of f.keys) {
      expect(keccak256(k.publicKey)).toBe(k.keyStoreKeyId);
      expect(k.publicKey.length).toBeGreaterThanOrEqual(130);
    }
  });
});
