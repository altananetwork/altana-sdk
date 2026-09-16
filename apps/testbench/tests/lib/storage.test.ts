import { describe, expect, test } from "vitest";
import { EMPTY_STATE, STORAGE_KEY, isPrivateKey, load, migrate, save } from "../../src/lib/storage";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("storage", () => {
  test("migrate accepts junk and returns an empty v1 state", () => {
    expect(migrate(null)).toEqual({ v: 1, sessions: [] });
    expect(migrate("nope")).toEqual({ v: 1, sessions: [] });
    expect(migrate({ walletKey: "0x12", sessions: "x" })).toEqual({ v: 1, sessions: [] });
  });

  test("migrate keeps a valid key, chain and sessions and drops malformed sessions", () => {
    const good = { id: "a", name: "a", serialized: { walletAddress: "0x", publicKey: "0x", permissions: {}, expiry: 1 }, sessionKey: KEY, keyId: "0x1", legs: [], createdAt: 1 };
    const out = migrate({ v: 1, walletKey: KEY, chainId: 11142220, sessions: [good, { id: "b" }] });
    expect(out.walletKey).toBe(KEY);
    expect(out.chainId).toBe(11142220);
    expect(out.sessions).toHaveLength(1);
  });

  test("load tolerates broken JSON and save round-trips", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    map.set(STORAGE_KEY, "{not json");
    expect(load(storage)).toEqual(EMPTY_STATE);
    save(storage, { v: 1, walletKey: KEY, chainId: 84532, sessions: [] });
    expect(load(storage)).toEqual({ v: 1, walletKey: KEY, chainId: 84532, sessions: [] });
  });

  test("isPrivateKey", () => {
    expect(isPrivateKey(KEY)).toBe(true);
    expect(isPrivateKey(` ${KEY} `)).toBe(true);
    expect(isPrivateKey("0xabc")).toBe(false);
  });
});
