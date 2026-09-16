import { describe, expect, test } from "vitest";
import { redact, stringify } from "../../src/lib/log";

describe("log redaction", () => {
  test("hides signers and keys, stringifies bigints", () => {
    const out = redact({ signer: { address: "0x1" }, sessionSigner: {}, value: 5n, nested: { privateKey: "0xdead", ok: [1n] } }) as Record<string, unknown>;
    expect(out.signer).toBe("[redacted]");
    expect(out.sessionSigner).toBe("[redacted]");
    expect(out.value).toBe("5");
    expect((out.nested as Record<string, unknown>).privateKey).toBe("[redacted]");
    expect(stringify({ a: 1n })).toContain('"1"');
  });
});
