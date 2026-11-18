import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { CELO, BASE_SEPOLIA } from "../config.js";
import { explainRelayFailure } from "../errors.js";
import { nativeValueShortfall } from "./relay.js";

/**
 * A KeyStore registration is paid in the chain's own currency, as value the
 * calls send, whatever token the relay's fee is charged in. A wallet that pays
 * the relay in a stablecoin and is short of CELO for the registration used to
 * be told "the relay gave no reason": it held plenty of the token it named, so
 * no shortfall was established (fork of Celo mainnet, 2026-11-18).
 */
const CONTROLLER = CELO.keyStoreController;
const OTHER = "0x00000000000000000000000000000000000000aa" as const;
const registration = (value: bigint) => ({ to: CONTROLLER, value, data: "0x" as const });

describe("native value the calls send that the wallet cannot cover", () => {
  test("short of CELO for one registration: need is the value, have is the balance, and it is a registration", () => {
    const short = nativeValueShortfall({
      calls: [registration(parseEther("9.2")), { to: OTHER, data: "0x" }],
      funded: false,
      nativeBalance: parseEther("3"),
      network: CELO,
    });
    expect(short).toEqual({
      token: { symbol: "CELO", decimals: 18 },
      need: parseEther("9.2"),
      have: parseEther("3"),
      fund: { chain: "Celo", tokens: ["CELO"] },
      purpose: "registration",
    });
  });

  test("a first setup sends two registrations: the need is their sum", () => {
    const short = nativeValueShortfall({
      calls: [registration(parseEther("9.2")), registration(parseEther("9.2"))],
      funded: false,
      nativeBalance: 0n,
      network: CELO,
    });
    expect(short?.need).toBe(parseEther("18.4"));
    expect(short?.have).toBe(0n);
    expect(short?.purpose).toBe("registration");
  });

  test("a balance that covers the value is not a shortfall, exactly equal included", () => {
    for (const nativeBalance of [parseEther("9.2"), parseEther("40")]) {
      expect(nativeValueShortfall({ calls: [registration(parseEther("9.2"))], funded: false, nativeBalance, network: CELO })).toBeUndefined();
    }
  });

  test("calls that send no value never produce one, whatever the balance", () => {
    expect(nativeValueShortfall({ calls: [{ to: OTHER, data: "0x" }], funded: false, nativeBalance: 0n, network: CELO })).toBeUndefined();
  });

  test("value sent somewhere else is a shortfall, but not called a registration", () => {
    const short = nativeValueShortfall({ calls: [{ to: OTHER, value: parseEther("1") }], funded: false, nativeBalance: 0n, network: CELO });
    expect(short?.need).toBe(parseEther("1"));
    expect(short?.purpose).toBeUndefined();
    const mixed = nativeValueShortfall({ calls: [registration(parseEther("9.2")), { to: OTHER, value: 1n }], funded: false, nativeBalance: 0n, network: CELO });
    expect(mixed?.purpose).toBeUndefined();
  });

  test("an intent funded from another chain pays its value there: nothing is said about this chain", () => {
    expect(nativeValueShortfall({ calls: [registration(parseEther("9.2"))], funded: true, nativeBalance: 0n, network: BASE_SEPOLIA })).toBeUndefined();
  });
});

describe("the sentence a person reads", () => {
  test("names the registration, the amount needed, the amount held, and where to add it", () => {
    const shortfall = nativeValueShortfall({ calls: [registration(parseEther("9.2"))], funded: false, nativeBalance: parseEther("3"), network: CELO })!;
    const err = explainRelayFailure({ relayMessage: "intent reverted: 0x", shortfall, chain: CELO.chain });
    expect(err.code).toBe("insufficient_funds");
    expect(err.message).toBe("Not enough CELO for the registration: needs about 9.2 CELO, you have 3 CELO. Add CELO on Celo.");
  });

  test("a shortfall that is not a registration keeps the wording it had", () => {
    const err = explainRelayFailure({
      relayMessage: "intent reverted: 0x",
      shortfall: { token: { symbol: "CELO", decimals: 18 }, need: parseEther("16.2"), have: parseEther("4.1"), fund: { chain: "Celo", tokens: ["CELO"] } },
    });
    expect(err.message).toBe("Not enough CELO to pay for this: needs about 16.2 CELO, you have 4.1 CELO. Add CELO on Celo.");
  });
});
