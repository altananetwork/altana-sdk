import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA, type FeeCurrency, type HoldingsResult } from "@altananetwork/sdk";
import { vi } from "vitest";
import type { TestbenchClient } from "../lib/sdk";

export const USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const;
export const EURM = "0xA99dC247d6b7B2E3ab48a1fEE101b83cD6aCd82a" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const celoFees: FeeCurrency[] = [
  { uid: "demo-native", address: ZERO, symbol: "CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true },
  { uid: "eurm", address: EURM, symbol: "EURm", decimals: 18, nativeRate: 14428785000000000000n, isNative: false },
  { uid: "usdc", address: USDC, symbol: "USDC", decimals: 6, nativeRate: 666666666666666666n, isNative: false },
];

export const holdingsWithUsdc: HoldingsResult = {
  native: 0n,
  tokens: [{ address: USDC, ok: true, raw: 2_000_000n, decimals: 6, symbol: "USDC", display: "2" }],
};

export type FakeClient = TestbenchClient & { [K in keyof TestbenchClient]: TestbenchClient[K] };

/** A recording client with sensible defaults; override any method per test. */
export function fakeClient(overrides: Partial<TestbenchClient> = {}): FakeClient {
  const chains = [CELO_SEPOLIA, BASE_SEPOLIA, SEPOLIA];
  return {
    chains,
    createWallet: vi.fn(async (signer) => ({ address: signer.address })),
    holdings: vi.fn(async () => holdingsWithUsdc),
    feeCurrencies: vi.fn(async (chainId) => ({ chainId, currencies: celoFees, rateTtl: 300 })),
    execute: vi.fn(async () => ({ callsId: "0x01" as const, status: "CONFIRMED" as const, transactionHash: "0xabc" as const, feeToken: USDC })),
    grantSession: vi.fn(async () => {
      throw new Error("grantSession not configured in this test");
    }),
    quoteGrantSession: vi.fn(async () => ({ lines: [], balances: [], complete: true })),
    quoteRevokeSession: vi.fn(async () => ({ lines: [], balances: [], complete: true })),
    revokeSession: vi.fn(async () => ({ keyId: "0x01" as const, status: "revoked" as const, legs: [] })),
    ...overrides,
  };
}

export const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
