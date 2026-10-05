import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA, type FeeCurrency, type HoldingsResult } from "@altananetwork/sdk";
import { vi } from "vitest";
import type { MirrorReading } from "../lib/mirror";
import type { TestbenchClient } from "../lib/sdk";

export const USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const;
export const EURM = "0xA99dC247d6b7B2E3ab48a1fEE101b83cD6aCd82a" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const celoFees: FeeCurrency[] = [
  { uid: "demo-native", address: ZERO, symbol: "CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true },
  { uid: "eurm", address: EURM, symbol: "EURm", decimals: 18, nativeRate: 14428785000000000000n, isNative: false },
  { uid: "usdc", address: USDC, symbol: "USDC", decimals: 6, nativeRate: 666666666666666666n, isNative: false },
];

/**
 * A mirror reading whose key is registered on Ethereum, carried by the anchor,
 * and proven against the block Celo anchors right now: state (c), "current".
 * Tests override the fields that make it one of the other four.
 */
export const mirrorCurrent: MirrorReading = {
  anchorL1Block: 11807636n,
  l1Head: 11807712n,
  // Packed (nonce|lastUpdated|revoked|expiry|isRoot) with revoked=0, expiry=0.
  livePacked: 1n,
  anchorPacked: 1n,
  cachedSourceBlock: 11807636n,
  cachedRevoked: false,
  cachedExpiry: 0,
  cachedPresent: true,
  cacheSaysValid: true,
  readAt: 1_790_000_000,
};

/** Packs a KeyStore Key slot the way KeyStoreCacheOPStack._decodePackedKey reads it. */
export function packKey({ revoked = false, expiry = 0, isRoot = false } = {}): bigint {
  return 1n | (revoked ? 1n << 128n : 0n) | (BigInt(expiry) << 136n) | (isRoot ? 1n << 176n : 0n);
}

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
    // WebAuthn does not exist in jsdom, so a test that wants a passkey wallet
    // supplies the credential itself rather than prompting for one.
    createPasskeyWallet: vi.fn(async () => {
      throw new Error("createPasskeyWallet not configured in this test");
    }),
    recoverFromPasskey: vi.fn(async () => {
      throw new Error("recoverFromPasskey not configured in this test");
    }),
    holdings: vi.fn(async () => holdingsWithUsdc),
    feeCurrencies: vi.fn(async (chainId) => ({ chainId, currencies: celoFees, rateTtl: 300 })),
    execute: vi.fn(async () => ({ callsId: "0x01" as const, status: "CONFIRMED" as const, transactionHash: "0xabc" as const, feeToken: USDC })),
    // The relay's fee for a native send, in CELO: 0.09, as seen on Celo Sepolia on 2026-09-17.
    quoteExecute: vi.fn(async () => ({ fee: 90_000_000_000_000_000n, feeToken: ZERO, value: 0n, feeTokenDeficit: 0n, nativeNeeded: 90_000_000_000_000_000n, nativeNeededFromRelay: false })),
    grantSession: vi.fn(async () => {
      throw new Error("grantSession not configured in this test");
    }),
    quoteGrantSession: vi.fn(async () => ({ lines: [], balances: [], complete: true })),
    quoteRevokeSession: vi.fn(async () => ({ lines: [], balances: [], complete: true })),
    revokeSession: vi.fn(async () => ({ keyId: "0x01" as const, status: "revoked" as const, legs: [], cacheSync: Promise.resolve([]) })),
    permit2Readiness: vi.fn(async () => ({ tokenAllowance: 0n, checkers: [] as readonly `0x${string}`[] })),
    approvePermit2Token: vi.fn(async () => ({
      callsId: "0x01" as const,
      status: "CONFIRMED" as const,
      transactionHash: "0xapprovetoken" as const,
    })),
    approvePermit2Checker: vi.fn(async () => ({
      callsId: "0x02" as const,
      status: "CONFIRMED" as const,
      transactionHash: "0xapprovechecker" as const,
    })),
    getErc8004Agent: vi.fn(async () => {
      throw new Error("getErc8004Agent not configured in this test");
    }),
    registerErc8004Agent: vi.fn(async () => {
      throw new Error("registerErc8004Agent not configured in this test");
    }),
    fetchWithX402: vi.fn(async () => {
      throw new Error("fetchWithX402 not configured in this test");
    }),
    readMirror: vi.fn(async () => mirrorCurrent),
    proveIntoMirror: vi.fn(async () => ({
      status: "CONFIRMED",
      transactionHash: "0xproof" as const,
      l1BlockNumber: 11847946n,
      attempts: 1,
    })),
    ...overrides,
  };
}

/** A headless passkey credential, for tests and for the fake client. */
export const TEST_PASSKEY_CREDENTIAL = {
  kind: "webauthn" as const,
  id: "dGVzdC1jcmVkZW50aWFs",
  publicKey:
    "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809" as const,
  rpId: "localhost",
};

export const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const TEST_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
