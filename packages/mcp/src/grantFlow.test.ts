import { describe, expect, test } from "bun:test";
import { storeKeyThenGrant } from "./grantFlow.js";

describe("the order of a session grant", () => {
  test("the key is stored before the grant is sent", async () => {
    const order: string[] = [];
    const result = await storeKeyThenGrant({
      storeKey: async () => { order.push("store"); },
      grant: async () => { order.push("grant"); return "granted"; },
      removeKey: async () => { order.push("remove"); },
    });
    expect(result).toBe("granted");
    expect(order).toEqual(["store", "grant"]);
  });

  test("when the key cannot be stored, nothing is sent and nothing is paid", async () => {
    let granted = false;
    await expect(
      storeKeyThenGrant({
        storeKey: async () => { throw new Error("keychain is locked"); },
        grant: async () => { granted = true; return 1; },
        removeKey: async () => {},
      }),
    ).rejects.toThrow("keychain is locked");
    expect(granted).toBe(false);
  });

  test("when the grant fails, the stored key is removed and the grant's error is the one reported", async () => {
    const order: string[] = [];
    await expect(
      storeKeyThenGrant({
        storeKey: async () => { order.push("store"); },
        grant: async () => { order.push("grant"); throw new Error("Not enough CELO"); },
        removeKey: async () => { order.push("remove"); },
      }),
    ).rejects.toThrow("Not enough CELO");
    expect(order).toEqual(["store", "grant", "remove"]);
  });

  test("a clean-up that fails does not hide why the grant failed", async () => {
    await expect(
      storeKeyThenGrant({
        storeKey: async () => {},
        grant: async () => { throw new Error("Not enough CELO"); },
        removeKey: async () => { throw new Error("keychain is locked"); },
      }),
    ).rejects.toThrow("Not enough CELO");
  });
});
