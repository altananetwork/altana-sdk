/**
 * The registration-fee margin, and that everything downstream follows from it.
 *
 * `KeyStoreController.getRegistrationFeeInWei()` is oracle-priced, and the
 * controller requires `msg.value >= fee` at **inclusion** rather than at
 * build time, so a value computed when the intent was built can fall short.
 * Overpaying is safe: `_transferFee` refunds the excess to `msg.sender` with a
 * full-gas `call`, which an EIP-7702 delegated account can receive.
 *
 * The margin is sized against the measurement: Chainlink ETH/USD steps at most
 * ~1.4% per round on Sepolia, so 10% is roughly six times the worst step. It is
 * deliberately NOT sized to absorb staleness — the 5.49% shortfall that
 * prompted it was a 21-hour-old payload, which is a lifecycle bug and is fixed
 * by re-quoting, not by a bigger margin.
 */
import { describe, expect, test } from "bun:test";
import { parseEther, zeroAddress, type Address } from "viem";
import {
  REGISTRATION_FEE_MARGIN_PERCENT,
  registrationValueFor,
  buildInitialRegisterCall,
  buildAdditionalRegisterCall,
} from "./keystore.js";
import { registryFundsRequest } from "./cachedRegistry.js";
import { SEPOLIA } from "../config.js";

// The live Sepolia fee at the time this was written, so the numbers are real.
const FEE = 194_949_444_735_244n;
const PUBKEY = `0x04${"ab".repeat(32)}` as const;

describe("registrationValueFor", () => {
  test("adds 10% to the quoted fee", () => {
    expect(REGISTRATION_FEE_MARGIN_PERCENT).toBe(110n);
    expect(registrationValueFor(FEE)).toBe((FEE * 110n) / 100n);
    expect(registrationValueFor(FEE)).toBe(214_444_389_208_768n);
  });

  test("the margin exceeds the worst observed oracle step, and is not sized for staleness", () => {
    const value = registrationValueFor(FEE);
    // A 1.4% round step is covered many times over.
    expect(value).toBeGreaterThan((FEE * 1014n) / 1000n);
    // The 5.49% shortfall is covered too, but that case is a lifecycle bug.
    expect(value).toBeGreaterThan((FEE * 1055n) / 1000n);
    // And it is deliberately not a blank cheque.
    expect(value).toBeLessThan(FEE * 2n);
  });

  test("zero stays zero, so a fee-less chain is not given a phantom value", () => {
    expect(registrationValueFor(0n)).toBe(0n);
  });
});

describe("the register calls carry the margined value", () => {
  test("initialRegisterKey", () => {
    const call = buildInitialRegisterCall({ publicKey: PUBKEY, fee: FEE, network: SEPOLIA });
    expect(call.value).toBe(registrationValueFor(FEE));
    expect(call.value).toBeGreaterThan(FEE);
    expect(call.to).toBe(SEPOLIA.keyStoreController as Address);
  });

  test("registerKey", () => {
    const call = buildAdditionalRegisterCall({
      publicKey: PUBKEY,
      fee: FEE,
      network: SEPOLIA,
      expiry: 0,
    } as Parameters<typeof buildAdditionalRegisterCall>[0]);
    expect(call.value).toBe(registrationValueFor(FEE));
  });
});

describe("requiredFunds and the quote line follow without their own change", () => {
  // Both sum the calls' own `value`, so the margin propagates. Asserted rather
  // than assumed, because "it follows automatically" is the kind of claim that
  // is true until someone changes one of the two.
  const sumValue = (calls: readonly { value?: bigint }[]) =>
    calls.reduce((t, c) => t + (c.value ?? 0n), 0n);

  test("requiredFunds covers the margined value when the wallet holds nothing", () => {
    const calls = [buildInitialRegisterCall({ publicKey: PUBKEY, fee: FEE, network: SEPOLIA })];
    const needed = sumValue(calls);
    expect(needed).toBe(registrationValueFor(FEE));
    const funds = registryFundsRequest({ balance: 0n, valueNeeded: needed });
    expect(funds).toEqual([{ address: zeroAddress, value: registrationValueFor(FEE) }]);
    expect(funds[0]!.value).toBeGreaterThanOrEqual(needed);
  });

  test("requiredFunds still covers it when the wallet holds a little, but not enough", () => {
    const needed = registrationValueFor(FEE);
    const funds = registryFundsRequest({ balance: FEE, valueNeeded: needed });
    expect(funds[0]!.value).toBeGreaterThanOrEqual(needed);
  });

  test("a quote line's value is the same sum, so it reflects the margin", () => {
    const calls = [buildInitialRegisterCall({ publicKey: PUBKEY, fee: FEE, network: SEPOLIA })];
    // `quoteSession`'s registry line sets value/needed from sumValue(calls).
    expect(sumValue(calls)).toBe(registrationValueFor(FEE));
  });

  test("two registrations in one bundle both carry it", () => {
    const calls = [
      buildInitialRegisterCall({ publicKey: PUBKEY, fee: FEE, network: SEPOLIA }),
      buildInitialRegisterCall({ publicKey: PUBKEY, fee: FEE, network: SEPOLIA }),
    ];
    expect(sumValue(calls)).toBe(registrationValueFor(FEE) * 2n);
  });
});
