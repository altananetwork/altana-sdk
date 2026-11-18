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

/**
 * Celo tokens. USDC is Circle's native deployment (EIP-712 domain name
 * "USDC", version "2", 6 decimals). USD₮ and USA₮ are Tether's, 6 decimals
 * each. All three have the EIP-3009 surface (`transferWithAuthorization`), so
 * each serves the eip3009 rail as well as permit2-exact. Domain values are
 * verified on chain (`DOMAIN_SEPARATOR()` / `decimals()`), and
 * `tokens.test.ts` recomputes each mainnet domain separator from the config.
 * Permit2 is at its canonical address on both Celo chains.
 */

/** USDC on Celo mainnet (42220). eip3009 and permit2-exact rails. */
export const USDC_CELO: TokenConfig = {
  address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
  name: "USDC",
  version: "2",
  symbol: "USDC",
  decimals: 6,
};

/** USDC on Celo Sepolia (11142220). eip3009 and permit2-exact rails. */
export const USDC_CELO_SEPOLIA: TokenConfig = {
  address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E",
  name: "USDC",
  version: "2",
  symbol: "USDC",
  decimals: 6,
};

/**
 * Tether on Celo (42220). eip3009 and permit2-exact rails. **`USD₮` names two different contracts on Celo**, and
 * this is the one that pays x402: 6 decimals, with the EIP-3009 surface. The
 * other is an 18-decimal entry in the FeeCurrencyDirectory that gas is quoted
 * through, and it is not a payment token. Both report `symbol() = "USD₮"` and `name() = "Tether USD"`,
 * so a ticker does not identify a token here — select by address. The same
 * split exists for `USAT`.
 *
 * Verified on chain 2026-10-05: symbol `USD₮`, name `Tether USD`, decimals 6,
 * `authorizationState` answers.
 */
export const USDT_CELO: TokenConfig = {
  address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  name: "Tether USD",
  version: "1",
  // The token's own symbol(), not the plain-ASCII "USDT": the exact ticker is
  // what a reader compares against a fee-currency list.
  symbol: "USD₮",
  decimals: 6,
};

/** USDT on Celo Sepolia (11142220). eip3009 and permit2-exact rails. */
export const USDT_CELO_SEPOLIA: TokenConfig = {
  address: "0xd077A400968890Eacc75cdc901F0356c943e4fDb",
  name: "Tether USD",
  version: "1",
  // Its own symbol(), verified on chain 2026-10-05; see USDT_CELO.
  symbol: "USD₮",
  decimals: 6,
};

/**
 * USA₮ (Tether America USD) on Celo mainnet (42220). eip3009 and
 * permit2-exact rails. Celo Sepolia has no USA₮.
 *
 * Like USD₮, the name covers two contracts on Celo: this 6-decimal token is
 * the one that pays x402, and an 18-decimal entry in the FeeCurrencyDirectory
 * (`0x0357EE22278c922e1D36cFe6b899269b161880C4`) is what gas is quoted
 * through. Select by address.
 *
 * Verified on chain 2026-11-18: `eip712Domain()` answers name
 * `Tether America USD`, version `1`; `symbol()` is the plain-ASCII `USAT`;
 * decimals 6; `transferWithAuthorization` is present.
 */
export const USAT_CELO: TokenConfig = {
  address: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771",
  name: "Tether America USD",
  version: "1",
  // The token's own symbol(), which is ASCII here, unlike USD₮'s.
  symbol: "USAT",
  decimals: 6,
};
