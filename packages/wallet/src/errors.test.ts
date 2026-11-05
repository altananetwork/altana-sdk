import { describe, expect, test } from "bun:test";
import {
  altanaErrorOf,
  classifyRelayFailure,
  explainRelayFailure,
  isAltanaError,
  readableAmount,
  type RelayFailureFacts,
} from "./errors.js";

/**
 * One test per mapping, each from a message a relay or a client has actually
 * produced, plus the two rules the map is built around: a cause the relay
 * named outranks a low balance, and a sentence never names an asset on a
 * chain the payer does not pay from.
 */

/** The Celo-funded registration: CELO is what the person pays with. */
const CELO_SHORTFALL = {
  token: { symbol: "CELO", decimals: 18 },
  need: 16_200_000_000_000_000_000n,
  have: 4_100_000_000_000_000_000n,
  fund: { chain: "Celo", tokens: ["CELO", "USDC", "USDT"] },
} as const;

describe("not enough to pay", () => {
  test("the sentence Doris asked for: need, have, and what to add where", () => {
    const err = explainRelayFailure({
      relayMessage: "intent reverted: 0x",
      operation: "registering this key on Ethereum",
      shortfall: CELO_SHORTFALL,
    });
    expect(err.code).toBe("insufficient_funds");
    expect(err.message).toBe(
      "Not enough CELO to pay for registering this key on Ethereum: needs about 16.2 CELO, you have 4.1 CELO. " +
        "Add CELO, USDC or USDT on Celo.",
    );
  });

  test("a Celo-funded failure never mentions the destination chain's asset", () => {
    // The whole product is registering on Ethereum while holding no ETH there.
    // A message that reports the empty ETH balance as the problem describes
    // the feature as a fault, and sends the reader to the wrong faucet.
    const err = explainRelayFailure({
      relayMessage:
        "its simulation reverted with no reason on Sepolia (chainId 11155111), sending 0.000227 ETH; " +
        "the wallet cannot pay for it: it holds 0 ETH on Sepolia",
      operation: "registering this key on Ethereum",
      shortfall: CELO_SHORTFALL,
      chain: { name: "Sepolia", chainId: 11155111 },
    });
    expect(err.message).not.toContain("ETH on Sepolia");
    expect(err.message).not.toContain("ETH");
    expect(err.message).toContain("Not enough CELO");
    // The relay's words are kept, out of the way, for the debug log.
    expect(err.relayMessage).toContain("0 ETH on Sepolia");
  });

  test("no figure is invented when the relay would not quote", () => {
    const err = explainRelayFailure({
      relayMessage: "intent reverted: 0x",
      operation: "this transfer",
      shortfall: { token: { symbol: "CELO", decimals: 18 }, have: 0n, fund: { chain: "Celo Sepolia", tokens: ["CELO", "USDC"] } },
    });
    expect(err.message).toBe("Not enough CELO to pay for this transfer: you have 0 CELO. Add CELO, USDC on Celo Sepolia.".replace("CELO, USDC", "CELO or USDC"));
    expect(err.message).not.toContain("about");
  });

  test("the relay's own figures lead when the SDK has none", () => {
    // Infra's wording. It is already a plain sentence in the payer's token, so
    // it is used as it stands, with the SDK's next action added.
    const err = explainRelayFailure({
      relayMessage: "not enough CELO on Celo Sepolia: need 16.2 CELO, have 4.1 CELO",
      operation: "this transfer",
    });
    expect(err.code).toBe("insufficient_funds");
    expect(err.message).toBe("Not enough CELO on Celo Sepolia: need 16.2 CELO, have 4.1 CELO. Add funds and try again.");
  });

  test("the relay's structural refusals map here too, when balances are short", () => {
    for (const relayMessage of ["QuoteHasDeficits", "InsufficientLiquidity", "quote has asset deficits", "intent reverted: 0x"]) {
      expect(classifyRelayFailure({ relayMessage, shortfall: CELO_SHORTFALL })).toBe("insufficient_funds");
    }
  });

  test("a revert with no reason and no shortfall is not dressed up as one", () => {
    // qa lost an hour to the opposite: a wallet holding 133x the fee was told
    // it could not pay (evidence/2026-09-28-s3-registry-write-reverts-0x.md).
    const err = explainRelayFailure({ relayMessage: "intent reverted: 0x" });
    expect(err.code).toBe("unknown");
    expect(err.message).not.toContain("Not enough");
    // "0x" is not a sentence, so it is not quoted at a person; it is in the log.
    expect(err.message).toBe("This could not be carried out, and the relay gave no reason. Try again; the debug log has the whole failure.");
    expect(err.relayMessage).toBe("intent reverted: 0x");
  });
});

describe("the other common failures", () => {
  const cases: readonly { name: string; facts: RelayFailureFacts; code: string; says: string; action: string }[] = [
    {
      name: "quote expired",
      facts: { relayMessage: "quote expired" },
      code: "quote_expired",
      says: "The price for this expired",
      action: "Try again",
    },
    {
      name: "session expired",
      facts: { relayMessage: "KeyExpired()" },
      code: "session_expired",
      says: "This session key has expired.",
      action: "Grant a new session key",
    },
    {
      name: "spend limit exceeded",
      facts: { relayMessage: "ExceededSpendLimit(token: 0x01C5…, 0x9054c912)", feeSymbol: "USDC" },
      code: "spend_limit_exceeded",
      says: "spending limit does not cover this in USDC",
      action: "higher limit",
    },
    {
      name: "no spend permission for the token",
      facts: { relayMessage: "NoSpendPermissions()" },
      code: "spend_limit_exceeded",
      says: "spending limit does not cover this",
      action: "higher limit",
    },
    {
      name: "call not permitted",
      facts: { relayMessage: "UnauthorizedCall()" },
      code: "call_not_permitted",
      says: "not allowed to make this call",
      action: "Grant a new session key that allows it",
    },
    {
      name: "relay unreachable",
      facts: { relayMessage: "HTTP request failed", relayUrl: "https://relay.altana.network" },
      code: "relay_unreachable",
      says: "Could not reach the Altana relay at https://relay.altana.network.",
      action: "Check the connection",
    },
    {
      name: "chain not served",
      facts: { relayMessage: "Cannot destructure property 'contracts' of '[intermediate value]' as it is undefined.", chain: { name: "Base Sepolia", chainId: 84532 } },
      code: "chain_not_served",
      says: "Altana does not serve Base Sepolia yet.",
      action: "Switch to a chain it serves",
    },
    {
      name: "price unavailable",
      facts: { relayMessage: "fee currency rate unavailable for 0xA99d…", feeSymbol: "EURm" },
      code: "price_unavailable",
      says: "No price was available for EURm",
      action: "pay the fee in another token",
    },
  ];
  for (const c of cases) {
    test(`${c.name}: one sentence, then what to do`, () => {
      const err = explainRelayFailure(c.facts);
      expect(err.code).toBe(c.code as typeof err.code);
      expect(err.statement).toContain(c.says);
      expect(err.action).toContain(c.action);
      expect(err.message).toBe(`${err.statement} ${err.action}`);
      // One line, and no jargon the relay happened to use.
      expect(err.message).not.toContain("\n");
      expect(err.message).not.toContain("0x9054c912");
    });
  }

  test("a cause the relay named outranks a wallet that is also low", () => {
    // A spend cap is the cause even when the balance would have failed next.
    expect(classifyRelayFailure({ relayMessage: "ExceededSpendLimit", shortfall: CELO_SHORTFALL })).toBe("spend_limit_exceeded");
    expect(classifyRelayFailure({ relayMessage: "KeyExpired", shortfall: CELO_SHORTFALL })).toBe("session_expired");
    expect(classifyRelayFailure({ relayMessage: "quote expired", shortfall: CELO_SHORTFALL })).toBe("quote_expired");
  });

  test("an unrecognised relay message is shown as it stands", () => {
    const err = explainRelayFailure({ relayMessage: "fee token not supported: 0xdead" });
    expect(err.code).toBe("unknown");
    expect(err.statement).toBe("Fee token not supported: 0xdead.");
  });
});

describe("the error object", () => {
  test("it carries the code, the detail and the relay's words, and is recognised through a cause chain", () => {
    const cause = new Error("viem: RPC Request failed");
    const err = explainRelayFailure({
      relayMessage: "intent reverted: 0x",
      shortfall: CELO_SHORTFALL,
      operation: "registering this key on Ethereum",
      detail: "the long form: 1 call to 0x…, the wallet holds 4.1 CELO on Celo Sepolia and 0 ETH on Sepolia",
      cause,
    });
    expect(isAltanaError(err)).toBe(true);
    expect(err.cause).toBe(cause);
    expect(err.detail).toContain("0 ETH on Sepolia");
    expect(altanaErrorOf(new Error("wrapped", { cause: err }))).toBe(err);
    expect(altanaErrorOf(new Error("unrelated"))).toBeUndefined();
  });
});

describe("amounts a person reads", () => {
  test("six decimals, trailing zeros gone, and dust never rounded to nothing", () => {
    expect(readableAmount(16_200_000_000_000_000_000n, 18)).toBe("16.2");
    expect(readableAmount(0n, 18)).toBe("0");
    expect(readableAmount(622_991n, 6)).toBe("0.622991");
    expect(readableAmount(184_677_000_000_000_000n, 18)).toBe("0.184677");
    // A fee with more precision than anyone reads is cut, not rounded up.
    expect(readableAmount(227_583_771_143_727n, 18)).toBe("0.000227");
    // Dust: cutting would say 0, which is false, so the exact figure stays.
    expect(readableAmount(1n, 18)).toBe("0.000000000000000001");
  });
});
