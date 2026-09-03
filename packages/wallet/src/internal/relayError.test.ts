/**
 * Relay-error legibility (issue #72): the relay explains rejections precisely,
 * but viem/porto bury that message under a generic wrapper. deepestRelayReason
 * digs it back out so the SDK can lead the thrown error with it.
 */
import { describe, expect, test } from "bun:test";
import { deepestRelayReason } from "./relay.js";

// The exact shape seen live on BSC testnet when feeToken is set to $U:
// InvalidParamsRpcError → RpcRequestError → the real relay message.
const feeTokenError = Object.assign(new Error("Invalid parameters were provided to the RPC method. Double check you have provided the correct parameters."), {
  code: -32602,
  cause: Object.assign(new Error("RPC Request failed.\nURL: https://testnet-relay.altana.network\nRequest body: {...}"), {
    code: -32602,
    details: "fee token not supported: 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    cause: Object.assign(new Error("fee token not supported: 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"), {
      code: -32602,
    }),
  }),
});

describe("deepestRelayReason", () => {
  test("extracts the real reason from under viem's generic wrapper", () => {
    expect(deepestRelayReason(feeTokenError)).toBe(
      "fee token not supported: 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    );
  });

  test("prefers a specific `details` over a generic `message`", () => {
    const e = Object.assign(new Error("RPC Request failed"), {
      details: "quote expired",
    });
    expect(deepestRelayReason(e)).toBe("quote expired");
  });

  test("returns undefined when every layer is a generic wrapper", () => {
    const e = Object.assign(new Error("Invalid parameters were provided to the RPC method"), {
      cause: new Error("RPC Request failed"),
    });
    expect(deepestRelayReason(e)).toBeUndefined();
  });

  test("takes only the first line of a multi-line message", () => {
    const e = new Error("some deep error\nURL: https://x\nRequest body: {...}");
    expect(deepestRelayReason(e)).toBe("some deep error");
  });

  test("does not loop forever on a cyclic cause chain", () => {
    const a: any = new Error("Invalid parameters were provided to the RPC method");
    a.cause = a;
    expect(() => deepestRelayReason(a)).not.toThrow();
    expect(deepestRelayReason(a)).toBeUndefined();
  });
});
