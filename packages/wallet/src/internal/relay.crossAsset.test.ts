/**
 * Reading a cross-asset quote: per leg, per chain, per token.
 *
 * Every case runs against a recorded `wallet_prepareCalls` response. The
 * baseline is a real same-asset (1:1) multichain capture from relay-staging
 * (2026-10-15); the cross-asset pair is that same capture re-priced the way a
 * cross-asset relay would, at a stated rate, so the arithmetic here can be
 * checked by hand. See each fixture's own `comment`.
 */
import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { NATIVE_TOKEN } from "../config.js";
import {
  feeFromPrepared,
  fundedFromChainIdOf,
  nativeNeededFromPrepared,
  needsFromPrepared,
  outgoingDiffs,
} from "./relay.js";
import oneToOne from "./fixtures/celo-sepolia-multichain-prepare-calls.json";
import crossCelo from "./fixtures/celo-sepolia-cross-asset-celo-prepare-calls.json";
import crossUsdc from "./fixtures/celo-sepolia-cross-asset-usdc-prepare-calls.json";
import singleChain from "./fixtures/celo-sepolia-prepare-calls.json";

/** The wallet in the recorded captures. */
const WALLET: Address = "0x4bd3e4cd87458b0d6a935e53d81939a792f9287f";
const SEPOLIA = 11155111;
const CELO_SEPOLIA = 11142220;
const USDC: Address = "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B";

/** Figures read straight out of the captures, so the sums below are checkable. */
const SOURCE_FEE_CELO = 431_917_980_004_319_161n;
const DEST_FEE_ETH = 4_289_542_639_492n;
const FUND_TRANSFER_ETH = 236_604_958_884_629n;
/** FUND_TRANSFER_ETH at ETH/USD 3000.00, CELO/USD 0.30, plus the 2% margin. */
const ESCROW_CELO = 2_413_370_580_623_215_800n;
/** The same, as $1 stablecoin units with 6 decimals. */
const ESCROW_USDC = 724_012n;
const SOURCE_FEE_USDC = 129_576n;

/** What `quoteCalls` does: resolve the funding chain, then read the quote. */
function read(prepared: unknown, ownChainId = SEPOLIA) {
  const payChainId = fundedFromChainIdOf(prepared, ownChainId);
  const { fee, feeToken, feeTokenDeficit, charges } = feeFromPrepared(prepared, { payChainId });
  const args = {
    fee,
    value: 0n,
    feeToken: feeToken ?? NATIVE_TOKEN,
    charges,
    ownChainId,
    payer: WALLET,
    ...(payChainId !== undefined ? { payChainId } : {}),
  };
  return { payChainId, fee, feeToken, feeTokenDeficit, charges, ...nativeNeededFromPrepared(prepared, args) };
}

describe("the recorded same-asset (1:1) multichain quote", () => {
  test("both legs are reported, each on its own chain", () => {
    const r = read(oneToOne);
    expect(r.payChainId).toBe(CELO_SEPOLIA);
    expect(r.charges).toEqual([
      { chainId: CELO_SEPOLIA, feeToken: NATIVE_TOKEN, fee: SOURCE_FEE_CELO, feeTokenDeficit: 0n },
      { chainId: SEPOLIA, feeToken: NATIVE_TOKEN, fee: DEST_FEE_ETH, feeTokenDeficit: 0n },
    ]);
  });

  test("the fee is the leg the payer pays, not CELO wei plus ETH wei", () => {
    // Both legs say `paymentToken: 0x0`, but that one address stands for CELO
    // on one chain and ETH on the other, so the old sum was adding two assets.
    const r = read(oneToOne);
    expect(r.fee).toBe(SOURCE_FEE_CELO);
    expect(r.fee).not.toBe(SOURCE_FEE_CELO + DEST_FEE_ETH);
    expect(r.feeToken).toBe(NATIVE_TOKEN);
  });

  test("the payer needs CELO on Celo Sepolia only: that leg's fee plus the escrow", () => {
    const r = read(oneToOne);
    expect(r.needs).toEqual([
      {
        chainId: CELO_SEPOLIA,
        token: NATIVE_TOKEN,
        amount: SOURCE_FEE_CELO + FUND_TRANSFER_ETH,
        fromRelay: false,
        symbol: "CELO",
        decimals: 18,
      },
    ]);
    expect(r.nativeNeeded).toBe(SOURCE_FEE_CELO + FUND_TRANSFER_ETH);
  });

  test("nothing is charged on the registry chain: the funder pays there and the escrow repays it", () => {
    expect(read(oneToOne).needs.some((n) => n.chainId === SEPOLIA)).toBe(false);
  });

  test("the escrow comes from the payer's own outgoing diff, and is not the destination fee", () => {
    expect(outgoingDiffs(oneToOne, { chainId: CELO_SEPOLIA, payer: WALLET })).toEqual([
      { token: NATIVE_TOKEN, amount: FUND_TRANSFER_ETH, symbol: "CELO", decimals: 18 },
    ]);
  });

  test("the relay's simulated diff carries the escrow and not that leg's fee, so the two add without overlapping", () => {
    // The whole per-chain figure rests on this: if the diff already contained
    // the fee, adding the fee again would double-count it.
    const [diff] = outgoingDiffs(oneToOne, { chainId: CELO_SEPOLIA, payer: WALLET });
    expect(diff!.amount).toBeLessThan(SOURCE_FEE_CELO);
  });

  test("another address's diffs are not the payer's", () => {
    expect(outgoingDiffs(oneToOne, { chainId: CELO_SEPOLIA, payer: "0x" + "11".repeat(20) as Address })).toEqual([]);
    expect(outgoingDiffs(oneToOne, { chainId: 999, payer: WALLET })).toEqual([]);
  });
});

describe("a cross-asset quote paid in CELO", () => {
  test("the legs are priced in different assets and only the payer's is charged", () => {
    const r = read(crossCelo);
    expect(r.charges).toEqual([
      { chainId: CELO_SEPOLIA, feeToken: NATIVE_TOKEN, fee: SOURCE_FEE_CELO, feeTokenDeficit: 0n },
      { chainId: SEPOLIA, feeToken: NATIVE_TOKEN, fee: DEST_FEE_ETH, feeTokenDeficit: 0n },
    ]);
    expect(r.fee).toBe(SOURCE_FEE_CELO);
  });

  test("the need is the converted escrow plus the source fee, in CELO on Celo Sepolia", () => {
    const r = read(crossCelo);
    expect(r.needs).toEqual([
      {
        chainId: CELO_SEPOLIA,
        token: NATIVE_TOKEN,
        amount: SOURCE_FEE_CELO + ESCROW_CELO,
        fromRelay: false,
        symbol: "CELO",
        decimals: 18,
      },
    ]);
    expect(r.nativeNeeded).toBe(SOURCE_FEE_CELO + ESCROW_CELO);
  });

  test("the converted escrow is 10 000x the 1:1 one, which is the whole point", () => {
    // 1 ETH = 10 000 CELO at the fixture's rate. The old reading charged the
    // user the ETH figure in CELO wei and would have under-reported by 10 000x.
    const [need] = read(crossCelo).needs;
    const [old] = read(oneToOne).needs;
    expect(need!.amount).toBeGreaterThan(old!.amount * 5n);
  });
});

describe("a cross-asset quote paid in a 6-decimal stablecoin", () => {
  test("the fee is quoted in USDC, not in the chain's native token", () => {
    const r = read(crossUsdc);
    expect(r.feeToken).toBe(USDC);
    expect(r.fee).toBe(SOURCE_FEE_USDC);
    expect(r.charges[0]).toEqual({ chainId: CELO_SEPOLIA, feeToken: USDC, fee: SOURCE_FEE_USDC, feeTokenDeficit: 0n });
    expect(r.charges[1]!.feeToken).toBe(NATIVE_TOKEN);
  });

  test("the need is USDC base units on Celo Sepolia, with the token's own decimals", () => {
    expect(read(crossUsdc).needs).toEqual([
      {
        chainId: CELO_SEPOLIA,
        token: USDC,
        amount: SOURCE_FEE_USDC + ESCROW_USDC,
        fromRelay: false,
        symbol: "USDC",
        decimals: 6,
      },
    ]);
  });

  test("no native balance is needed anywhere: a wallet holding only USDC can register", () => {
    const r = read(crossUsdc);
    expect(r.nativeNeeded).toBe(0n);
    expect(r.needs.every((n) => n.token !== NATIVE_TOKEN)).toBe(true);
  });

  test("the amount is not readable as 18 decimals: that is a 1e12 error", () => {
    const [need] = read(crossUsdc).needs;
    expect(need!.decimals).toBe(6);
    expect(need!.amount).toBeLessThan(10n ** 7n);
  });
});

describe("a single-chain quote is unchanged", () => {
  test("one leg, one charge, the fee and the relay's deficit as before", () => {
    const r = read(singleChain, CELO_SEPOLIA);
    expect(r.payChainId).toBeUndefined();
    expect(r.charges).toEqual([
      { chainId: CELO_SEPOLIA, feeToken: NATIVE_TOKEN, fee: 32_151_600_000_321_516n, feeTokenDeficit: 32_151_600_000_321_516n },
    ]);
    expect(r.fee).toBe(32_151_600_000_321_516n);
    expect(r.needs).toEqual([
      { chainId: CELO_SEPOLIA, token: NATIVE_TOKEN, amount: 32_151_600_000_321_516n, fromRelay: true },
    ]);
  });

  test("the value the calls carry is added to the fee on the same chain", () => {
    const payChainId = undefined;
    expect(
      needsFromPrepared(singleChain, {
        fee: 7n,
        feeToken: NATIVE_TOKEN,
        value: 11n,
        ownChainId: CELO_SEPOLIA,
        ...(payChainId !== undefined ? { payChainId } : {}),
        payer: WALLET,
      }),
    ).toEqual([
      // 18 > 7 + 11 would mean the two landed on different keys; the relay's
      // own deficit then raises it, which is what `fromRelay` says.
      { chainId: CELO_SEPOLIA, token: NATIVE_TOKEN, amount: 32_151_600_000_321_516n, fromRelay: true },
    ]);
  });
});

describe("a relay that sends no asset diffs", () => {
  /** The recorded multichain quote with `capabilities.assetDiffs` removed. */
  const noDiffs = (() => {
    const copy = structuredClone(oneToOne) as any;
    delete copy.capabilities.assetDiffs;
    return copy;
  })();

  test("falls back to the 1:1 figure: every leg's fee, on the funding chain", () => {
    const r = read(noDiffs);
    expect(r.needs).toEqual([
      { chainId: CELO_SEPOLIA, token: NATIVE_TOKEN, amount: SOURCE_FEE_CELO + DEST_FEE_ETH, fromRelay: false },
    ]);
    // Which is exactly what the SDK reported before this change.
    expect(r.nativeNeeded).toBe(SOURCE_FEE_CELO + DEST_FEE_ETH);
  });

  test("the same is true when the payer is unknown", () => {
    const payChainId = fundedFromChainIdOf(oneToOne, SEPOLIA);
    const needs = needsFromPrepared(oneToOne, {
      fee: SOURCE_FEE_CELO,
      feeToken: NATIVE_TOKEN,
      value: 0n,
      ownChainId: SEPOLIA,
      ...(payChainId !== undefined ? { payChainId } : {}),
    });
    expect(needs).toEqual([
      { chainId: CELO_SEPOLIA, token: NATIVE_TOKEN, amount: SOURCE_FEE_CELO + DEST_FEE_ETH, fromRelay: false },
    ]);
  });
});

describe("a short wallet on the funding chain", () => {
  /** The cross-asset USDC quote with the relay reporting a USDC deficit. */
  const short = (() => {
    const copy = structuredClone(crossUsdc) as any;
    const source = copy.context.quote.quotes.find((q: any) => Number(q.chainId) === CELO_SEPOLIA);
    source.assetDeficits = [{ address: USDC, required: "0x1e8480", deficit: "0x1e8480" }]; // 2_000_000
    return copy;
  })();

  test("the relay's own figure wins when it is higher, and says so", () => {
    expect(read(short).needs).toEqual([
      { chainId: CELO_SEPOLIA, token: USDC, amount: 2_000_000n, fromRelay: true, symbol: "USDC", decimals: 6 },
    ]);
  });

  test("a deficit on the registry chain is not charged to the payer", () => {
    // It is why the relay funded the intent at all; the escrow already covers it.
    const destShort = structuredClone(crossUsdc) as any;
    const dest = destShort.context.quote.quotes.find((q: any) => Number(q.chainId) === SEPOLIA);
    dest.assetDeficits = [{ address: null, required: "0xde0b6b3a7640000", deficit: "0xde0b6b3a7640000" }];
    expect(read(destShort).needs.some((n) => n.chainId === SEPOLIA)).toBe(false);
  });
});
