import { describe, expect, test } from "bun:test";
import { hashDomain, getAddress, type Hex } from "viem";
import { USAT_CELO, USDC_CELO, USDT_CELO, type TokenConfig } from "./tokens.js";

/**
 * A buyer signs an EIP-3009 payment over the token's EIP-712 domain, so a
 * wrong name or version in a token config produces signatures the token
 * rejects. Each `DOMAIN_SEPARATOR()` below was read from Celo mainnet (42220)
 * on 2026-11-18; the test recomputes it from the config, which fails the
 * moment a name, version or address in the config stops matching the token.
 */
const CELO = 42220;
const ON_CHAIN: Array<{ token: TokenConfig; label: string; domainSeparator: Hex }> = [
  { token: USDC_CELO, label: "USDC", domainSeparator: "0xb2ce31d2838445fa765a491f550e7c78ac7280ab0f3bc9d6063a86df9c3fb578" },
  { token: USDT_CELO, label: "USD₮", domainSeparator: "0xbcb4d62e4834b598d0eacecd84c0b397a0254e077c41cf2143e394d5701d1088" },
  { token: USAT_CELO, label: "USA₮", domainSeparator: "0xe6bbb7920a85afd44befe87c998da24b8b655c972faf8a8acbdf38c829ff8bf2" },
];

const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

describe("Celo mainnet token configs", () => {
  for (const { token, label, domainSeparator } of ON_CHAIN) {
    test(`${label}: the config's name and version give the token's own domain separator`, () => {
      const computed = hashDomain({
        domain: { name: token.name, version: token.version, chainId: CELO, verifyingContract: token.address },
        types: { EIP712Domain: EIP712_DOMAIN },
      });
      expect(computed).toBe(domainSeparator);
    });

    test(`${label}: 6 decimals and a checksummed address`, () => {
      expect(token.decimals).toBe(6);
      expect(token.address).toBe(getAddress(token.address));
    });
  }

  test("USA₮ is Tether America USD, and its symbol is the token's own ASCII one", () => {
    expect(USAT_CELO.name).toBe("Tether America USD");
    expect(USAT_CELO.version).toBe("1");
    expect(USAT_CELO.symbol).toBe("USAT");
  });

  test("the three tokens are three different contracts", () => {
    expect(new Set(ON_CHAIN.map((t) => t.token.address.toLowerCase())).size).toBe(3);
  });
});
