/**
 * Relay-error legibility (issue #72): the relay explains rejections precisely,
 * but viem/porto bury that message under a generic wrapper. deepestRelayReason
 * digs it back out so the SDK can lead the thrown error with it.
 */
import { describe, expect, test } from "bun:test";
import { BNB_TESTNET_FAUCET_URL, deepestRelayReason, relayHint } from "./relay.js";

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

// Issue #83: the reason alone is often bare contract output. relayHint is the
// pure "what to do" suffix; the caller supplies any chain reads via ctx.
describe("relayHint", () => {
  const W = "0x00000000000000000000000000000000000000a1" as const;

  test("unfunded first transaction: empty revert + balance below the calls' native value", () => {
    const hint = relayHint("0x", { chainId: 97, walletAddress: W, nativeBalance: 0n, requiredNative: 1_000n });
    expect(hint).toContain("holds no native balance");
    expect(hint).toContain("KeyStore registration fee");
    expect(hint).toContain(W);
    expect(hint).toContain(BNB_TESTNET_FAUCET_URL);
  });

  test("funded but short: says both numbers; no faucet link off testnet", () => {
    const hint = relayHint("intent reverted: 0x", { chainId: 56, walletAddress: W, nativeBalance: 5n, requiredNative: 9n });
    expect(hint).toContain("holds 5 wei but the calls send 9 wei");
    expect(hint).not.toContain(BNB_TESTNET_FAUCET_URL);
  });

  test("empty revert with enough balance is some other revert: no hint", () => {
    expect(relayHint("0x", { chainId: 97, walletAddress: W, nativeBalance: 10n, requiredNative: 9n })).toBe("");
    // No context (the balance read failed): never guess.
    expect(relayHint("0x")).toBe("");
  });

  test("NoSpendPermissions: decoded name and raw selector", () => {
    for (const reason of ["intent reverted: NoSpendPermissions(NoSpendPermissions)", "intent reverted: 0x5ee7e5b1"]) {
      const hint = relayHint(reason);
      expect(hint).toContain("no spend limit for a token this transaction spends");
      expect(hint).toContain("native spend limit");
    }
  });

  test("ExceededSpendLimit: token-specific, native mentions fees, raw selector falls back to native", () => {
    const erc20 = relayHint("intent reverted: ExceededSpendLimit(ExceededSpendLimit { token: 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565 })");
    expect(erc20).toContain("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565");
    expect(erc20).toContain("decimals");
    const native = relayHint("intent reverted: ExceededSpendLimit(ExceededSpendLimit { token: 0x0000000000000000000000000000000000000000 })");
    expect(native).toContain("native spend cap");
    expect(relayHint("intent reverted: 0x9054c912")).toContain("native spend cap");
  });

  test("fee token keeps its existing hint; unrelated reasons get none", () => {
    expect(relayHint("fee token not supported: 0xabc")).toContain("omit `feeToken`");
    expect(relayHint("quote expired")).toBe("");
  });
});
