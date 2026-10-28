/**
 * The fee token rule, on the pure pieces: ranking candidates against the
 * relay's list, choosing by source, the failures before anything is sent,
 * and the spend caps a grant adds for its fee tokens.
 */
import { describe, expect, test } from "bun:test";
import { numberToHex, type Address, type Client } from "viem";
import { BNB, CELO_SEPOLIA, NATIVE_TOKEN } from "../config.js";
import type { FeeCurrency } from "./feeCurrencies.js";
import {
  addFeeSpendCaps,
  chooseFeeToken,
  feeTokenCandidatesOf,
  nativeWhenNothingToPayWith,
  rankFeeCandidates,
  resolveFeeToken,
} from "./feeTokenSelection.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const USDM: Address = "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";
const USDT_BNB: Address = "0x55d398326f99059fF775485246999027B3197955";

const celo: FeeCurrency = { uid: "celo", address: NATIVE_TOKEN, symbol: "CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true };
const usdc: FeeCurrency = { uid: "usdc", address: USDC, symbol: "USDC", decimals: 6, nativeRate: 12n * 10n ** 18n, isNative: false };
const usdm: FeeCurrency = { uid: "usdm", address: USDM, symbol: "USDm", decimals: 18, nativeRate: 12n * 10n ** 18n, isNative: false };
const CELO_ACCEPTED = [celo, usdc, usdm];
const bnb: FeeCurrency = { uid: "bnb", address: NATIVE_TOKEN, symbol: "BNB", decimals: 18, nativeRate: 10n ** 18n, isNative: true };
const BNB_ACCEPTED = [bnb];

const held = (entries: [Address, bigint][]) =>
  new Map(entries.map(([a, raw]) => [a.toLowerCase(), raw] as const));

describe("feeTokenCandidatesOf", () => {
  test("the spend cap's tokens, native for a cap without one", () => {
    expect(
      feeTokenCandidatesOf({
        spend: [
          { limit: 1n, period: "day" },
          { limit: 1n, period: "day", token: USDC },
        ],
      }),
    ).toEqual([NATIVE_TOKEN, USDC]);
    expect(feeTokenCandidatesOf({ calls: [] })).toEqual([]);
    expect(feeTokenCandidatesOf(undefined)).toEqual([]);
  });
});

describe("rankFeeCandidates", () => {
  test("keeps accepted candidates in caller order, valued at the relay's rate", () => {
    const ranked = rankFeeCandidates(
      [USDT_BNB, USDC.toLowerCase() as Address, NATIVE_TOKEN, USDC],
      CELO_ACCEPTED,
      held([
        [USDC, 2_000_000n],
        [NATIVE_TOKEN, 5n * 10n ** 17n],
      ]),
    );
    expect(ranked.map((r) => r.currency.symbol)).toEqual(["USDC", "CELO"]);
    // 2 USDC at 12 CELO each = 24 CELO in native wei.
    expect(ranked[0]!.value).toBe(24n * 10n ** 18n);
    expect(ranked[1]!.value).toBe(5n * 10n ** 17n);
  });
});

describe("chooseFeeToken", () => {
  test("session on BNB with a USDT cap and native in the cap: USDT is not accepted, BNB is", () => {
    const token = chooseFeeToken({
      candidates: [USDT_BNB, NATIVE_TOKEN],
      accepted: BNB_ACCEPTED,
      held: held([[NATIVE_TOKEN, 10n ** 18n]]),
      source: "session",
      network: BNB,
      walletAddress: WALLET,
    });
    expect(token).toBe(NATIVE_TOKEN);
  });

  test("session: the accepted cap token the wallet holds the most of, in relay terms", () => {
    const token = chooseFeeToken({
      candidates: [NATIVE_TOKEN, USDC, USDM],
      accepted: CELO_ACCEPTED,
      held: held([
        [NATIVE_TOKEN, 10n ** 18n], // 1 CELO
        [USDC, 1_000_000n], // 1 USDC = 12 CELO
        [USDM, 5n * 10n ** 17n], // 0.5 USDm = 6 CELO
      ]),
      source: "session",
      network: CELO_SEPOLIA,
      walletAddress: WALLET,
    });
    expect(token).toBe(USDC);
  });

  test("feeToken list: the first accepted and held token in the caller's order", () => {
    const token = chooseFeeToken({
      candidates: [USDT_BNB, USDM, USDC],
      accepted: CELO_ACCEPTED,
      held: held([
        [USDM, 1n],
        [USDC, 10n ** 12n],
      ]),
      source: "feeToken",
      network: CELO_SEPOLIA,
      walletAddress: WALLET,
    });
    expect(token).toBe(USDM);
  });

  test("none accepted: throws naming the relay's list", () => {
    expect(() =>
      chooseFeeToken({
        candidates: [USDT_BNB],
        accepted: BNB_ACCEPTED,
        held: held([[USDT_BNB, 10n ** 18n]]),
        source: "session",
        network: BNB,
        walletAddress: WALLET,
      }),
    ).toThrow(/in the session's spend permission .* is a fee token the relay accepts on BNB Smart Chain .* It accepts: BNB/);
  });

  test("none held: throws naming what could have paid and what the relay accepts", () => {
    expect(() =>
      chooseFeeToken({
        candidates: [USDC, NATIVE_TOKEN],
        accepted: CELO_ACCEPTED,
        held: held([]),
        source: "feeToken",
        network: CELO_SEPOLIA,
        walletAddress: WALLET,
      }),
    ).toThrow(new RegExp(`The wallet ${WALLET} holds none of the tokens .*: USDC, CELO\\. Fund it .* accepts CELO, USDC, USDm`));
  });
});

/**
 * A relay that answers only the two reads the empty-wallet rule makes, and
 * records what it was asked. `wire` entries are the relay's own
 * `wallet_getCapabilities` shape; balances are its ERC-7811 answer.
 */
function fakeRelay(o: {
  chainId: number;
  tokens: { uid: string; address: Address; decimals: number; symbol: string; feeToken?: boolean }[];
  balances?: Record<string, bigint>;
  native?: bigint;
  failOn?: "wallet_getCapabilities" | "wallet_getAssets";
}) {
  const methods: string[] = [];
  const relay = {
    async request({ method }: { method: string }) {
      methods.push(method);
      if (method === o.failOn) throw new Error(`relay is down (${method})`);
      if (method === "wallet_getCapabilities") {
        return {
          [numberToHex(o.chainId)]: {
            fees: {
              tokens: o.tokens.map((t) => ({
                uid: t.uid,
                address: t.address,
                decimals: t.decimals,
                symbol: t.symbol,
                feeToken: t.feeToken ?? true,
                nativeRate: "0xde0b6b3a7640000",
              })),
            },
          },
        };
      }
      if (method === "wallet_getAssets") {
        return {
          [numberToHex(o.chainId)]: [
            { address: "native", balance: numberToHex(o.native ?? 0n), type: "native" },
            ...Object.entries(o.balances ?? {}).map(([address, raw]) => ({
              address: address.toLowerCase(),
              balance: numberToHex(raw),
              type: "erc20",
            })),
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as Client;
  return { relay, methods };
}

const CELO_TOKENS = [
  { uid: "celo", address: NATIVE_TOKEN as Address, decimals: 18, symbol: "CELO" },
  { uid: "usdc", address: USDC, decimals: 6, symbol: "USDC" },
  { uid: "usdm", address: USDM, decimals: 18, symbol: "USDm" },
];

describe("nativeWhenNothingToPayWith", () => {
  test("a wallet holding none of the relay's fee tokens is quoted in native", async () => {
    const { relay, methods } = fakeRelay({ chainId: CELO_SEPOLIA.chainId, tokens: CELO_TOKENS });
    expect(
      await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
    ).toBe(NATIVE_TOKEN);
    expect(methods).toEqual(["wallet_getCapabilities", "wallet_getAssets"]);
  });

  test("a wallet holding a stablecoin keeps the relay's choice", async () => {
    const { relay } = fakeRelay({
      chainId: CELO_SEPOLIA.chainId,
      tokens: CELO_TOKENS,
      balances: { [USDC]: 3_000_000n },
    });
    expect(
      await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
    ).toBeUndefined();
  });

  test("any native balance at all keeps the relay's choice", async () => {
    const { relay } = fakeRelay({ chainId: CELO_SEPOLIA.chainId, tokens: CELO_TOKENS, native: 1n });
    expect(
      await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
    ).toBeUndefined();
  });

  test("a token the wallet holds but the relay does not accept does not count as holding", async () => {
    const { relay } = fakeRelay({
      chainId: CELO_SEPOLIA.chainId,
      tokens: CELO_TOKENS,
      balances: { [USDT_BNB]: 50n * 10n ** 18n },
    });
    expect(
      await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
    ).toBe(NATIVE_TOKEN);
  });

  test("a one-token relay is left alone: it would pick native anyway, and no balance is read", async () => {
    const { relay, methods } = fakeRelay({
      chainId: CELO_SEPOLIA.chainId,
      tokens: [CELO_TOKENS[0]!],
    });
    expect(
      await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
    ).toBeUndefined();
    expect(methods).toEqual(["wallet_getCapabilities"]);
  });

  test("a relay that accepts no native fee token is left alone", async () => {
    const { relay } = fakeRelay({
      chainId: CELO_SEPOLIA.chainId,
      tokens: [CELO_TOKENS[1]!, CELO_TOKENS[2]!],
    });
    expect(
      await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
    ).toBeUndefined();
  });

  test("either read failing leaves the choice to the relay, it never throws", async () => {
    for (const failOn of ["wallet_getCapabilities", "wallet_getAssets"] as const) {
      const { relay } = fakeRelay({ chainId: CELO_SEPOLIA.chainId, tokens: CELO_TOKENS, failOn });
      expect(
        await nativeWhenNothingToPayWith({ relay, network: CELO_SEPOLIA, walletAddress: WALLET }),
      ).toBeUndefined();
    }
  });
});

describe("resolveFeeToken, wallet key with nothing named", () => {
  test("empty wallet: native; wallet holding USDC: the relay's choice", async () => {
    const empty = fakeRelay({ chainId: CELO_SEPOLIA.chainId, tokens: CELO_TOKENS });
    expect(
      await resolveFeeToken({
        relay: empty.relay,
        network: CELO_SEPOLIA,
        walletAddress: WALLET,
        submittingKey: { role: "admin" },
      }),
    ).toBe(NATIVE_TOKEN);

    const funded = fakeRelay({
      chainId: CELO_SEPOLIA.chainId,
      tokens: CELO_TOKENS,
      balances: { [USDC]: 3_000_000n },
    });
    expect(
      await resolveFeeToken({
        relay: funded.relay,
        network: CELO_SEPOLIA,
        walletAddress: WALLET,
        submittingKey: { role: "admin" },
      }),
    ).toBeUndefined();
  });

  test("a named feeToken still wins, and is not looked up", async () => {
    const { relay, methods } = fakeRelay({ chainId: CELO_SEPOLIA.chainId, tokens: CELO_TOKENS });
    expect(
      await resolveFeeToken({
        relay,
        network: CELO_SEPOLIA,
        walletAddress: WALLET,
        feeToken: USDC,
        submittingKey: { role: "admin" },
      }),
    ).toBe(USDC);
    expect(methods).toEqual([]);
  });

  test("a session with no spend cap is unchanged: the relay picks", async () => {
    const { relay, methods } = fakeRelay({ chainId: CELO_SEPOLIA.chainId, tokens: CELO_TOKENS });
    expect(
      await resolveFeeToken({
        relay,
        network: CELO_SEPOLIA,
        walletAddress: WALLET,
        submittingKey: { role: "session", permissions: { spend: [] } },
      }),
    ).toBeUndefined();
    expect(methods).toEqual([]);
  });
});

describe("addFeeSpendCaps", () => {
  const permissions = { calls: [{ to: WALLET }], spend: [{ limit: 5n, period: "day" as const }] };

  test("adds a daily cap of one whole token for each fee token not yet capped", () => {
    const withCaps = addFeeSpendCaps(permissions, [USDC, NATIVE_TOKEN], CELO_ACCEPTED, CELO_SEPOLIA);
    expect(withCaps.calls).toEqual(permissions.calls);
    expect(withCaps.spend).toEqual([
      { limit: 5n, period: "day" }, // the native cap the caller set stays as is
      { limit: 1_000_000n, period: "day", token: USDC },
    ]);
  });

  test("feeSpendLimit overrides the amount of every added cap", () => {
    const withCaps = addFeeSpendCaps({ calls: [] }, [USDC, USDM], CELO_ACCEPTED, CELO_SEPOLIA, 7n);
    expect(withCaps.spend).toEqual([
      { limit: 7n, period: "day", token: USDC },
      { limit: 7n, period: "day", token: USDM },
    ]);
  });

  test("a token the relay does not accept is refused", () => {
    expect(() => addFeeSpendCaps({ calls: [] }, [USDT_BNB], BNB_ACCEPTED, BNB)).toThrow(
      /is not a fee token the relay accepts on BNB Smart Chain .* It accepts: BNB/,
    );
  });
});
