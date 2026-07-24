/**
 * Payment-token registry for the seller side.
 *
 * $U (United Stables) is the settlement token of the BNB agent economy —
 * BNB Agent Studio buyers sign EIP-3009 authorizations on it exclusively.
 * Addresses and the EIP-712 domain were verified against the live
 * `DOMAIN_SEPARATOR()` of both deployments; both implementations expose the
 * FiatTokenV2_2-style `transferWithAuthorization(bytes)` used to settle.
 */
import type { Address } from "viem";

export type TokenConfig = {
  address: Address;
  /** EIP-712 domain name (EIP-3009 verifyingContract domain). */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  symbol: string;
  decimals: number;
};

/** $U (United Stables) per chainId. */
export const U_TOKEN: Record<56 | 97, TokenConfig> = {
  56: {
    address: "0xcE24439F2D9C6a2289F741120FE202248B666666",
    name: "United Stables",
    version: "1",
    symbol: "U",
    decimals: 18,
  },
  97: {
    address: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
    name: "United Stables",
    version: "1",
    symbol: "U",
    decimals: 18,
  },
};

/** BSC-USDT (18 decimals) — the permit2-exact rail's default asset. */
export const USDT_BSC: TokenConfig = {
  address: "0x55d398326f99059fF775485246999027B3197955",
  name: "Tether USD",
  version: "1",
  symbol: "USDT",
  decimals: 18,
};
