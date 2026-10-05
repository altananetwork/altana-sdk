import { describe, expect, test } from "vitest";
import { encodeErrorResult } from "viem";
import { decodeRevertText, relayReason } from "../../src/lib/errors";
import { decodeRevertText as sdkDecode } from "../../../../packages/wallet/src/internal/relay";

const ERROR_ABI = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;
const PANIC_ABI = [{ type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] }] as const;

/** The blob qa had to slice by hand to learn what the chain had said. */
const MISMATCH_BLOB = encodeErrorResult({
  abi: ERROR_ABI,
  errorName: "Error",
  args: ["Cache: block header mismatch"],
});

describe("decodeRevertText", () => {
  test("an Error(string) blob becomes the sentence inside it", () => {
    expect(decodeRevertText(MISMATCH_BLOB)).toBe('"Cache: block header mismatch"');
  });

  test("it decodes a blob embedded in a longer message, not only a bare one", () => {
    const said = decodeRevertText(`the relay rejected the request: ${MISMATCH_BLOB}`);
    expect(said).toContain("Cache: block header mismatch");
    expect(said).not.toContain("0x08c379a0");
  });

  test("a panic becomes its code", () => {
    const blob = encodeErrorResult({ abi: PANIC_ABI, errorName: "Panic", args: [0x11n] });
    expect(decodeRevertText(blob)).toContain("panic code");
  });

  test("it matches the SDK's own decoder, so the two cannot drift apart", () => {
    for (const input of [MISMATCH_BLOB, `prefix ${MISMATCH_BLOB}`, "nothing to decode"]) {
      expect(decodeRevertText(input)).toBe(sdkDecode(input));
    }
  });

  test("text that is not revert data is left exactly as it was", () => {
    expect(decodeRevertText("quote has asset deficits")).toBe("quote has asset deficits");
    expect(decodeRevertText("0xdeadbeef")).toBe("0xdeadbeef");
  });

  test("a blob it cannot decode is kept rather than mangled", () => {
    const truncated = "0x08c379a0ff";
    expect(decodeRevertText(truncated)).toBe(truncated);
  });
});

describe("relayReason", () => {
  test("it decodes revert data found down the cause chain", () => {
    const inner = new Error(MISMATCH_BLOB);
    const outer = new Error("the relay rejected the request", { cause: inner });
    expect(relayReason(outer)).toContain("Cache: block header mismatch");
  });
});
