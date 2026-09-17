/**
 * Relay-error legibility (issue #72): the relay explains rejections precisely,
 * but viem/porto bury that message under a generic wrapper. deepestRelayReason
 * digs it back out so the SDK can lead the thrown error with it.
 */
import { describe, expect, test } from "bun:test";
import { decodeRevertText, deepestRelayReason, relayRejectionHint, shortfallMessage, type NativeHolding } from "./relay.js";

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

describe("relayRejectionHint", () => {
  test("tells a developer to create the wallet when the relay does not know the account", () => {
    expect(relayRejectionHint("quotes for unknown accounts are not accepted")).toContain("client.createWallet({ signer })");
  });
  test("adds nothing for other rejections", () => {
    expect(relayRejectionHint("insufficient liquidity")).toBe("");
  });
});

describe("shortfallMessage", () => {
  const eth = (chain: string, balance: bigint): NativeHolding => ({ chainId: 1, chain, symbol: "ETH", decimals: 18, balance });
  const celo = (balance: bigint): NativeHolding => ({ chainId: 2, chain: "Celo Sepolia", symbol: "CELO", decimals: 18, balance });

  test("an empty wallet that must send value: cannot pay, and nothing anywhere to fund it from", () => {
    expect(shortfallMessage(eth("Sepolia", 0n), 2n * 10n ** 14n, [celo(0n)])).toBe(
      "the wallet cannot pay for it: it holds 0 ETH on Sepolia and needs 0.0002 ETH the call sends plus the relay fee; " +
        "it holds nothing on any other chain the relay could fund it from",
    );
  });
  test("funds elsewhere the relay did not use are named", () => {
    expect(shortfallMessage(eth("Sepolia", 0n), 2n * 10n ** 14n, [celo(5n * 10n ** 17n), eth("Base Sepolia", 0n)])).toBe(
      "the wallet cannot pay for it: it holds 0 ETH on Sepolia and needs 0.0002 ETH the call sends plus the relay fee; " +
        "it holds 0.5 CELO on Celo Sepolia, which the relay could not use to fund it",
    );
  });
  test("value covered but the fee is not: names the balance without claiming certainty", () => {
    expect(shortfallMessage(eth("Sepolia", 10n ** 15n), 2n * 10n ** 14n, [])).toBe(
      "the wallet holds 0.001 ETH on Sepolia, which does not cover 0.0002 ETH the call sends plus the relay fee",
    );
  });
  test("no value: only the relay fee is named", () => {
    expect(shortfallMessage(eth("BNB Smart Chain", 0n), 0n, [])).toBe(
      "the wallet cannot pay for it: it holds 0 ETH on BNB Smart Chain and needs the relay fee",
    );
  });
});

describe("relayRejectionHint for an empty revert", () => {
  test("names the usual cause", () => {
    expect(relayRejectionHint("intent reverted: 0x")).toContain("cannot pay for");
    expect(relayRejectionHint("0x")).toContain("cannot pay for");
    expect(relayRejectionHint("intent reverted: PaymentError()")).toBe("");
  });
});

describe("decodeRevertText", () => {
  const badProof =
    "0x08c379a0" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000018" +
    "43616368653a206261642073746f726167652070726f6f660000000000000000";
  test("an Error(string) revert reads as its message", () => {
    expect(decodeRevertText(`intent reverted: ${badProof}`)).toBe('intent reverted: "Cache: bad storage proof"');
    expect(deepestRelayReason(Object.assign(new Error("x"), { details: badProof }))).toBe('"Cache: bad storage proof"');
  });
  test("a Panic reads as its code; other data is left alone", () => {
    expect(decodeRevertText("0x4e487b71" + "11".padStart(64, "0"))).toBe("panic code 17");
    expect(decodeRevertText("intent reverted: 0xf3dd7004")).toBe("intent reverted: 0xf3dd7004");
  });
});
