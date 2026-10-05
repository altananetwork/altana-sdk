/**
 * Relay-error legibility (issues #72, #83): the relay explains rejections
 * precisely, but viem/porto bury that message under a generic wrapper, and
 * some of what it does say is bare contract output. deepestRelayReason digs
 * the reason back out; relayRejectionHint and emptyRevertMessage turn it into
 * something a developer can act on, without claiming more than we checked.
 */
import { describe, expect, test } from "bun:test";
import {
  balanceClause,
  decodeRevertText,
  deepestRelayReason,
  emptyRevertMessage,
  relayRejectionHint,
  SEPOLIA_FAUCET_URL,
  type IntentChain,
  type NativeHolding,
} from "./relay.js";

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

  // Issue #83: both reach callers as bare contract output, and on the fee path
  // the Orchestrator re-reverts only the 4-byte selector.
  test("NoSpendPermissions, by decoded name and by raw selector", () => {
    for (const reason of ["intent reverted: NoSpendPermissions(NoSpendPermissions)", "intent reverted: 0x5ee7e5b1"]) {
      const hint = relayRejectionHint(reason);
      expect(hint).toContain("no spend limit for a token this transaction spends");
      expect(hint).toContain("native spend limit");
    }
  });

  test("ExceededSpendLimit names the token, or the native cap", () => {
    const erc20 = relayRejectionHint(
      "intent reverted: ExceededSpendLimit(ExceededSpendLimit { token: 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565 })",
    );
    expect(erc20).toContain("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565");
    expect(erc20).toContain("decimals");
    const native = relayRejectionHint(
      "intent reverted: ExceededSpendLimit(ExceededSpendLimit { token: 0x0000000000000000000000000000000000000000 })",
    );
    expect(native).toContain("native spend cap");
    expect(relayRejectionHint("intent reverted: 0x9054c912")).toContain("native spend cap");
  });

  // Without the balances there is nothing to check, so the hint says the
  // response carries no cause and lists the candidates. It claims neither.
  test("an empty revert says the response carries no cause, and asserts nothing", () => {
    for (const reason of ["intent reverted: 0x", "0x"]) {
      const hint = relayRejectionHint(reason);
      expect(hint).toContain("reverted with no reason");
      expect(hint).toContain("the usual ones are");
      expect(hint).not.toContain("does not cover");
    }
    expect(relayRejectionHint("intent reverted: PaymentError()")).toBe("");
  });
});

describe("emptyRevertMessage", () => {
  const sepolia: IntentChain = { chain: "Sepolia", chainId: 11155111, symbol: "ETH", decimals: 18 };
  const controller = "0x0000000000000000000000000000000000001234" as const;
  const keyStore = "0x0000000000000000000000000000000000005678" as const;
  const eth = (chain: string, chainId: number, balance: bigint): NativeHolding => ({ chainId, chain, symbol: "ETH", decimals: 18, balance });
  const celo = (balance: bigint): NativeHolding => ({ chainId: 11142220, chain: "Celo Sepolia", symbol: "CELO", decimals: 18, balance });

  // qa's exact case (evidence/2026-09-28-s3-registry-write-reverts-0x.md): the
  // registry write needs 0.000376475589991124 ETH, and the wallet holds far
  // more. The old message read "which does not cover", 133x wrong.
  const registryFee = 376_475_589_991_124n;
  const write = [{ to: controller, value: registryFee }];

  test("a balance above what the calls send is never called a shortfall", () => {
    for (const held of [10n ** 18n, 5n * 10n ** 16n]) {
      const message = emptyRevertMessage(sepolia, write, { here: eth("Sepolia", 11155111, held), elsewhere: [] });
      expect(message).toContain("its simulation reverted with no reason on Sepolia (chainId 11155111)");
      expect(message).toContain(`simulating 1 call to ${controller}, sending 0.000376475589991124 ETH`);
      expect(message).toContain("the wallet's balance is not the cause");
      expect(message).toContain("more than the 0.000376475589991124 ETH the calls send");
      expect(message).not.toContain("cannot pay");
      expect(message).not.toContain("does not cover");
    }
  });

  test("the exact sentence for a wallet holding 1 ETH", () => {
    expect(emptyRevertMessage(sepolia, write, { here: eth("Sepolia", 11155111, 10n ** 18n), elsewhere: [] })).toBe(
      "its simulation reverted with no reason on Sepolia (chainId 11155111), simulating 1 call to " +
        `${controller}, sending 0.000376475589991124 ETH; the wallet's balance is not the cause: it holds 1 ETH ` +
        "on Sepolia, more than the 0.000376475589991124 ETH the calls send",
    );
  });

  test("an empty wallet is a shortfall, and says where to fund it", () => {
    const message = emptyRevertMessage(sepolia, write, { here: eth("Sepolia", 11155111, 0n), elsewhere: [] });
    expect(message).toContain(
      "the wallet cannot pay for it: it holds 0 ETH on Sepolia and needs 0.000376475589991124 ETH the calls send plus the relay fee",
    );
    expect(message).toContain(SEPOLIA_FAUCET_URL);
  });

  test("funds the relay was asked to reach and did not use are named", () => {
    expect(emptyRevertMessage(sepolia, write, { here: eth("Sepolia", 11155111, 0n), elsewhere: [celo(5n * 10n ** 17n)] })).toContain(
      "it holds 0.5 CELO on Celo Sepolia, which the relay could not use to fund it",
    );
    expect(emptyRevertMessage(sepolia, write, { here: eth("Sepolia", 11155111, 0n), elsewhere: [celo(0n)] })).toContain(
      "it holds nothing on any other chain the relay could fund it from",
    );
  });

  test("a balance equal to the value the calls send cannot also pay the fee", () => {
    expect(emptyRevertMessage(sepolia, write, { here: eth("Sepolia", 11155111, registryFee), elsewhere: [] })).toContain(
      "the wallet cannot pay for it",
    );
  });

  test("calls that send nothing name only the relay fee", () => {
    expect(emptyRevertMessage(sepolia, [{ to: keyStore }], { here: eth("Sepolia", 11155111, 0n), elsewhere: [] })).toContain(
      "it holds 0 ETH on Sepolia and needs the relay fee",
    );
  });

  test("several calls are counted, their targets deduplicated, and their value summed", () => {
    const message = emptyRevertMessage(
      sepolia,
      [{ to: controller, value: 1n }, { to: keyStore, value: 2n }, { to: controller }],
      undefined,
    );
    expect(message).toBe(
      "its simulation reverted with no reason on Sepolia (chainId 11155111), simulating 3 calls to " +
        `${controller}, ${keyStore}, sending 0.000000000000000003 ETH`,
    );
  });

  test("no balances read: the chain and the calls still stand on their own", () => {
    const message = emptyRevertMessage(sepolia, write);
    expect(message).toContain("reverted with no reason on Sepolia");
    expect(message).not.toContain("the wallet");
  });

  test("no calls: the chain alone", () => {
    expect(emptyRevertMessage(sepolia, [])).toBe("its simulation reverted with no reason on Sepolia (chainId 11155111)");
  });
});

describe("balanceClause", () => {
  const bnb = (balance: bigint): NativeHolding => ({ chainId: 56, chain: "BNB Smart Chain", symbol: "BNB", decimals: 18, balance });

  test("a mainnet shortfall has no faucet to offer", () => {
    const clause = balanceClause(bnb(0n), 0n, []);
    expect(clause).toBe("the wallet cannot pay for it: it holds 0 BNB on BNB Smart Chain and needs the relay fee");
    expect(clause).not.toContain("fund it at");
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
    expect(deepestRelayReason(Object.assign(new Error("RPC Request failed"), { details: badProof }))).toBe('"Cache: bad storage proof"');
  });
  test("a Panic reads as its code; other data is left alone", () => {
    expect(decodeRevertText("0x4e487b71" + "11".padStart(64, "0"))).toBe("panic code 17");
    expect(decodeRevertText("intent reverted: 0xf3dd7004")).toBe("intent reverted: 0xf3dd7004");
  });
});
