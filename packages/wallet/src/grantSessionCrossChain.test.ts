import { describe, expect, it } from "bun:test";
import { isGatedL2Chain, BNB_TESTNET, SEPOLIA, BASE_SEPOLIA } from "./index.js";

describe("isGatedL2Chain", () => {
  it("is true for Base Sepolia (gate + l1ChainId, no keyStore)", () => {
    expect(isGatedL2Chain(BASE_SEPOLIA)).toBe(true);
  });

  it("is false for a full-stack chain (BNB testnet has its own keyStore)", () => {
    expect(isGatedL2Chain(BNB_TESTNET)).toBe(false);
  });

  it("is false for Sepolia (an L1 registry, no gate)", () => {
    expect(isGatedL2Chain(SEPOLIA)).toBe(false);
  });
});
