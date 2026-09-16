import { describe, expect, test } from "vitest";
import { relayReason } from "../../src/lib/errors";

describe("relayReason", () => {
  test("prefers the deepest details in the cause chain", () => {
    const err = Object.assign(new Error("outer"), {
      cause: Object.assign(new Error("middle"), { cause: { details: "fee token not supported: accepts CELO, USDC" } }),
    });
    expect(relayReason(err)).toBe("fee token not supported: accepts CELO, USDC");
  });
  test("falls back to message and strings", () => {
    expect(relayReason(new Error("plain"))).toBe("plain");
    expect(relayReason("text")).toBe("text");
  });
});
