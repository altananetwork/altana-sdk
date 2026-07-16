import type { Address, Hex } from "viem";
import type { TokenConfig } from "./tokens.js";

/** One rail (payment scheme) the merchant accepts. */
export type RailConfig =
  | {
      /** EIP-3009 `TransferWithAuthorization` — what Studio buyers sign ($U). */
      rail: "eip3009";
      token: TokenConfig;
    }
  | {
      /**
       * Permit2 `PermitWitnessTransferFrom` (B402 permit2-exact) — what Altana
       * smart-account buyers sign for any Permit2-approved token.
       */
      rail: "permit2-exact";
      token: TokenConfig;
      /** The settler that calls Permit2 (bound as `spender` in the signature). */
      spender: Address;
    };

export type MerchantConfig = {
  chainId: number;
  /** Where the money goes (e.g. the seller's Altana smart account). */
  payTo: Address;
  /** Quoted price per request, in atomic token units. */
  price: bigint;
  /** Clamp floor — a misconfigured/manipulated quote can never go below. */
  minPrice?: bigint;
  /** Clamp ceiling — and never above. */
  maxPrice?: bigint;
  rails: RailConfig[];
  /**
   * Authorization validity window offered in the challenge (default 300s).
   * Keep ≤480s: BNB Agent Studio buyers backdate validAfter by 120s and their
   * signer refuses windows over 600s.
   */
  maxTimeoutSeconds?: number;
  /** Resource URL echoed in the challenge (Studio buyers echo it back). */
  resource?: string;
  description?: string;
};

/** One `accepts[]` entry of the 402 challenge (x402 v2 / B402 wire shape). */
export type ChallengeAccept = {
  scheme: "exact";
  network: string;
  asset: Address;
  payTo: Address;
  amount: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    assetTransferMethod: "eip3009" | "permit2-exact";
    spenderAddress?: Address;
  };
};

export type ChallengeBody = {
  x402Version: 2;
  error: string;
  resource?: string;
  description?: string;
  accepts: ChallengeAccept[];
};

/** An X-PAYMENT header decoded and normalized across buyer envelope dialects. */
export type DecodedPayment = {
  rail: "eip3009" | "permit2" | "permit2-witness";
  /** Who pays (authorization.from / payload.from). */
  payer: Address;
  amount: bigint;
  token: Address;
  signature: Hex;
  chainId?: number;
  /** eip3009 rail. */
  authorization?: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
  /** permit2 rails. */
  permit?: {
    permitted: { token: Address; amount: string };
    spender: Address;
    nonce: string;
    deadline: string;
    witness?: { to: Address; validAfter: string };
  };
  /** The requirement the buyer chose, echoed back (may be absent). */
  accepted?: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type VerifyResult =
  | { ok: true; rail: DecodedPayment["rail"]; payer: Address; amount: bigint; token: Address }
  | { ok: false; reason: string };
