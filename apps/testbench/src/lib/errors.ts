import { decodeErrorResult, type Hex } from "viem";

/**
 * Solidity's two standard revert payloads. A contract that reverts with a
 * `require(..., "message")` encodes `Error(string)`, selector 0x08c379a0.
 */
const SOLIDITY_REVERTS = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as const;

/**
 * Replaces encoded `Error(string)` or `Panic(uint256)` revert data with what it
 * says.
 *
 * qa lost three minutes slicing an ABI blob by hand to discover the chain had
 * said "Cache: block header mismatch", a sentence that would have explained the
 * failure at a glance (2026-10-05). The relay passes revert data through
 * verbatim, so without this the most informative errors in the product are the
 * ones that read as noise.
 *
 * Mirrors `decodeRevertText` in the SDK, which is internal;
 * `tests/lib/errors.test.ts` pins the two together.
 */
export function decodeRevertText(reason: string): string {
  return reason.replace(/0x(08c379a0|4e487b71)[0-9a-fA-F]+/g, (data) => {
    try {
      const { errorName, args } = decodeErrorResult({ abi: SOLIDITY_REVERTS, data: data as Hex });
      return errorName === "Error" ? `"${String(args?.[0])}"` : `panic code ${String(args?.[0])}`;
    } catch {
      return data;
    }
  });
}

/** Walks an error's cause chain and returns the most specific human message. */
export function relayReason(err: unknown): string {
  let deepest = "";
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i++) {
    if (typeof e === "string") {
      deepest = e;
      break;
    }
    if (typeof e === "object") {
      const o = e as Record<string, unknown>;
      const details = typeof o.details === "string" ? o.details : undefined;
      const short = typeof o.shortMessage === "string" ? o.shortMessage : undefined;
      const message = typeof o.message === "string" ? o.message : undefined;
      const candidate = details || short || message;
      if (candidate) deepest = candidate;
      e = o.cause;
    } else {
      break;
    }
  }
  return decodeRevertText(deepest || String(err));
}
