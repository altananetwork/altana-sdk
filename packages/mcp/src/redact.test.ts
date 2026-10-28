import { describe, expect, test } from "bun:test";
import { redact, redactedMessage, redactUnknown, REDACTED } from "./redact.js";

// A throwaway key shape. Not a real key and never used to sign anything: the
// point is the 64 hex characters.
const KEYLIKE = `0x${"ab".repeat(32)}`;

describe("redact", () => {
  test("removes a 32 byte hex value with its 0x prefix", () => {
    expect(redact(`key=${KEYLIKE} rest`)).toBe(`key=${REDACTED} rest`);
    expect(redact(`key=${KEYLIKE}`)).not.toContain("abab");
  });

  test("removes one without the prefix too", () => {
    expect(redact("ab".repeat(32))).toBe(REDACTED);
  });

  test("removes every one in a line, not just the first", () => {
    const two = redact(`${KEYLIKE} and ${"cd".repeat(32)}`);
    expect(two).toBe(`${REDACTED} and ${REDACTED}`);
  });

  test("leaves an address alone, because an address is public and useful in a log", () => {
    const address = `0x${"ab".repeat(20)}`;
    expect(redact(`wallet ${address}`)).toContain(address);
  });

  test("leaves ordinary text alone", () => {
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });
});

describe("redactUnknown", () => {
  test("walks nested objects and arrays, which is where a handover payload hides a key", () => {
    const payload = {
      name: "trading-bot",
      inner: { sessionPrivateKey: KEYLIKE, list: [KEYLIKE] },
    };
    const out = JSON.stringify(redactUnknown(payload));
    expect(out).not.toContain("abab");
    expect(out).toContain("trading-bot");
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, "\\$&"), "g"))).toHaveLength(2);
  });

  test("an Error becomes a redacted line rather than an empty object", () => {
    expect(redactUnknown(new Error(`bad key ${KEYLIKE}`))).toBe(`Error: bad key ${REDACTED}`);
  });

  test("a bigint survives as a string, since JSON.stringify would throw on it", () => {
    expect(redactUnknown(10n)).toBe("10");
  });
});

describe("redactedMessage", () => {
  test("redacts a thrown Error's message", () => {
    expect(redactedMessage(new Error(`no ${KEYLIKE}`))).toBe(`no ${REDACTED}`);
  });

  test("handles a thrown non-Error", () => {
    expect(redactedMessage(KEYLIKE)).toBe(REDACTED);
  });
});
