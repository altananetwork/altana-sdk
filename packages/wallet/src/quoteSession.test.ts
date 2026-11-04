import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  slice,
  type Address,
  type Hex,
} from "viem";
import { CELO_SEPOLIA, NATIVE_TOKEN, SEPOLIA } from "./config.js";
import { formatQuoteLine, withBalances, type QuoteLine } from "./quoteSession.js";
import type { QuoteNeed } from "./internal/relay.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
/** USDC on Celo Sepolia, as the cross-asset fixtures use it. */
const USDC: Address = "0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A network's RPC host as the mock keys it. */
const rpc = (n: { publicRpcUrl: string }) => n.publicRpcUrl.replace(/\/$/, "");

/** ERC-20 selectors readTokenBalances asks for, by their 4-byte signature. */
const SELECTORS = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  supportsInterface: "0x01ffc9a7",
  blockTimestamp: "0x0f28c97d",
} as const;

/**
 * Answers `eth_getBalance` per RPC host and an ERC-20 token's reads through
 * multicall3, which is how `readTokenBalances` asks on Celo Sepolia. Anything
 * else is refused, so a test can never pass on a read it did not intend.
 */
function mockChain(o: {
  native?: Record<string, bigint>;
  token?: { address: Address; balance: bigint; decimals: number; symbol: string };
}) {
  const asked: string[] = [];
  const native = o.native ?? {};
  const answerInner = (target: Address, data: Hex): { success: boolean; returnData: Hex } => {
    const no = { success: false, returnData: "0x" as Hex };
    const selector = slice(data, 0, 4);
    if (selector === SELECTORS.blockTimestamp) {
      return { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [1_800_000_000n]) };
    }
    const t = o.token;
    if (!t || target.toLowerCase() !== t.address.toLowerCase()) return no;
    if (selector === SELECTORS.balanceOf) {
      return { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [t.balance]) };
    }
    if (selector === SELECTORS.decimals) {
      return { success: true, returnData: encodeAbiParameters([{ type: "uint8" }], [t.decimals]) };
    }
    if (selector === SELECTORS.symbol) {
      // string first; the bytes32 variant of the same selector then reverts,
      // which is the plain-ERC-20 shape.
      return { success: true, returnData: encodeAbiParameters([{ type: "string" }], [t.symbol]) };
    }
    // No ERC-165 and no BEP-677 extension: every other read reverts.
    return no;
  };
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url).replace(/\/$/, "");
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params?: any[] }) => {
      asked.push(`${u} ${req.method}`);
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1" };
      if (req.method === "eth_getBalance") {
        if (!(u in native)) throw new Error(`unexpected eth_getBalance to ${u}`);
        return { jsonrpc: "2.0", id: req.id, result: numberToHex(native[u]!) };
      }
      if (req.method === "eth_call") {
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: req.params![0].data as Hex });
        const calls = args![0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
        const results = calls.map((c) => answerInner(c.target, c.callData));
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }),
        };
      }
      throw new Error(`unexpected ${req.method} to ${u}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return asked;
}

const registryLine = (extra: Partial<QuoteLine>): QuoteLine => ({
  chainId: SEPOLIA.chainId,
  kind: "registry",
  via: "relay",
  payer: WALLET,
  fee: 3n,
  feeToken: NATIVE_TOKEN,
  value: 2n,
  needed: 5n,
  neededFromRelay: false,
  ...extra,
});

describe("quote balances for a registry write funded from the L2", () => {
  test("charges the source chain's balance, not the registry chain's", async () => {
    const asked = mockChain({ native: { [rpc(CELO_SEPOLIA)]: 10n } });
    const quote = await withBalances([registryLine({ fundedFromChainId: CELO_SEPOLIA.chainId })], [CELO_SEPOLIA]);
    expect(quote.balances).toEqual([
      {
        chainId: CELO_SEPOLIA.chainId,
        address: WALLET,
        token: NATIVE_TOKEN,
        symbol: CELO_SEPOLIA.chain.nativeCurrency.symbol,
        decimals: CELO_SEPOLIA.chain.nativeCurrency.decimals,
        balance: 10n,
        needed: 5n,
        sufficient: true,
      },
    ]);
    expect(asked.some((a) => a.startsWith(rpc(SEPOLIA)))).toBe(false);
  });

  test("a line without a source chain (a direct EOA write) is charged to the registry chain", async () => {
    mockChain({ native: { [rpc(SEPOLIA)]: 1n } });
    const quote = await withBalances([registryLine({})], [CELO_SEPOLIA]);
    expect(quote.balances[0]?.chainId).toBe(SEPOLIA.chainId);
    expect(quote.balances[0]?.sufficient).toBe(false);
  });

  test("formatQuoteLine names the source chain", () => {
    expect(formatQuoteLine(registryLine({ fundedFromChainId: CELO_SEPOLIA.chainId }), SEPOLIA)).toContain("funded from Celo Sepolia");
    expect(formatQuoteLine(registryLine({}), SEPOLIA)).not.toContain("funded from");
  });
});

describe("a first grant's cache legs", () => {
  test("are priced later, not failed", () => {
    const line: QuoteLine = {
      chainId: CELO_SEPOLIA.chainId,
      kind: "cache",
      payer: WALLET,
      feeToken: NATIVE_TOKEN,
      value: 0n,
      needed: 0n,
      neededFromRelay: false,
      deferred: true,
    };
    expect(formatQuoteLine(line, CELO_SEPOLIA)).toBe("chain 11142220 cache: fee priced once the registry write lands");
  });
});

/**
 * A cross-asset registry write: the leg runs on Ethereum Sepolia, the relay
 * funds it from Celo Sepolia, and the payer is charged there in CELO or in
 * USDC. The amounts are the ones the recorded fixtures carry
 * (`internal/fixtures/celo-sepolia-cross-asset-*-prepare-calls.json`): a
 * 2.845 CELO or 0.853588 USDC charge for a 0.0002366 ETH registration.
 */
const CELO_NEED = 2_845_288_560_627_534_961n;
const USDC_NEED = 853_588n;

const crossAssetLine = (need: QuoteNeed): QuoteLine => ({
  chainId: SEPOLIA.chainId,
  kind: "registry",
  via: "relay",
  payer: WALLET,
  fee: need.token === NATIVE_TOKEN ? 431_917_980_004_319_161n : 129_576n,
  feeToken: need.token,
  value: 236_604_958_884_629n,
  needed: need.token === NATIVE_TOKEN ? need.amount : 0n,
  neededFromRelay: false,
  fundedFromChainId: CELO_SEPOLIA.chainId,
  needs: [need],
});

const celoNeed: QuoteNeed = {
  chainId: CELO_SEPOLIA.chainId,
  token: NATIVE_TOKEN,
  amount: CELO_NEED,
  fromRelay: false,
  symbol: "CELO",
  decimals: 18,
};
const usdcNeed: QuoteNeed = {
  chainId: CELO_SEPOLIA.chainId,
  token: USDC,
  amount: USDC_NEED,
  fromRelay: false,
  symbol: "USDC",
  decimals: 6,
};

describe("balances for a cross-asset registry write", () => {
  test("a CELO charge is checked against the payer's CELO on Celo Sepolia", async () => {
    mockChain({ native: { [rpc(CELO_SEPOLIA)]: 3n * 10n ** 18n } });
    const quote = await withBalances([crossAssetLine(celoNeed)], [CELO_SEPOLIA]);
    expect(quote.balances).toEqual([
      {
        chainId: CELO_SEPOLIA.chainId,
        address: WALLET,
        token: NATIVE_TOKEN,
        symbol: CELO_SEPOLIA.chain.nativeCurrency.symbol,
        decimals: 18,
        balance: 3n * 10n ** 18n,
        needed: CELO_NEED,
        sufficient: true,
      },
    ]);
  });

  test("3 CELO covers the charge but 2 does not, so the margin is actually checked", async () => {
    mockChain({ native: { [rpc(CELO_SEPOLIA)]: 2n * 10n ** 18n } });
    const quote = await withBalances([crossAssetLine(celoNeed)], [CELO_SEPOLIA]);
    expect(quote.balances[0]?.sufficient).toBe(false);
  });

  test("a USDC charge is checked against the payer's USDC, not against anyone's native balance", async () => {
    const asked = mockChain({
      token: { address: USDC, balance: 1_000_000n, decimals: 6, symbol: "USDC" },
    });
    const quote = await withBalances([crossAssetLine(usdcNeed)], [CELO_SEPOLIA]);
    expect(quote.balances).toEqual([
      {
        chainId: CELO_SEPOLIA.chainId,
        address: WALLET,
        token: USDC,
        symbol: "USDC",
        decimals: 6,
        balance: 1_000_000n,
        needed: USDC_NEED,
        sufficient: true,
      },
    ]);
    // The whole bug: a wallet holding only USDC used to be checked for CELO.
    expect(asked.some((a) => a.endsWith("eth_getBalance"))).toBe(false);
  });

  test("0.5 USDC does not cover a 0.853588 USDC charge", async () => {
    mockChain({ token: { address: USDC, balance: 500_000n, decimals: 6, symbol: "USDC" } });
    const quote = await withBalances([crossAssetLine(usdcNeed)], [CELO_SEPOLIA]);
    expect(quote.balances[0]?.sufficient).toBe(false);
  });

  test("a token read that fails reports short, with the reason, never silently sufficient", async () => {
    mockChain({});
    const quote = await withBalances([crossAssetLine(usdcNeed)], [CELO_SEPOLIA]);
    expect(quote.balances[0]?.sufficient).toBe(false);
    expect(quote.balances[0]?.reason).toContain("balanceOf");
  });

  test("a wallet holding both CELO and USDC gets one row per token", async () => {
    mockChain({
      native: { [rpc(CELO_SEPOLIA)]: 3n * 10n ** 18n },
      token: { address: USDC, balance: 1_000_000n, decimals: 6, symbol: "USDC" },
    });
    const quote = await withBalances(
      [crossAssetLine(celoNeed), crossAssetLine(usdcNeed)],
      [CELO_SEPOLIA],
    );
    expect(quote.balances.map((b) => [b.token, b.needed, b.sufficient])).toEqual([
      [NATIVE_TOKEN, CELO_NEED, true],
      [USDC, USDC_NEED, true],
    ]);
  });

  test("two lines needing the same token on the same chain are added, not checked twice", async () => {
    mockChain({ token: { address: USDC, balance: 2_000_000n, decimals: 6, symbol: "USDC" } });
    const quote = await withBalances(
      [crossAssetLine(usdcNeed), crossAssetLine(usdcNeed)],
      [CELO_SEPOLIA],
    );
    expect(quote.balances).toHaveLength(1);
    expect(quote.balances[0]?.needed).toBe(USDC_NEED * 2n);
    expect(quote.balances[0]?.sufficient).toBe(true);
  });
});

describe("formatQuoteLine on a cross-asset write", () => {
  test("says what the payer pays, in CELO, on Celo Sepolia", () => {
    const out = formatQuoteLine(crossAssetLine(celoNeed), SEPOLIA);
    expect(out).toContain("pays 2.845288560627534961 CELO on Celo Sepolia Testnet");
    expect(out).toContain("funded from Celo Sepolia");
  });

  test("labels the fee in the token and on the chain it is charged on, not the registry chain's", () => {
    // The bug: a CELO fee printed as "0.431917980004319161 ETH".
    const out = formatQuoteLine(crossAssetLine(celoNeed), SEPOLIA);
    // The symbol is the one the relay's own asset diff named for the token.
    expect(out).toContain("fee 0.431917980004319161 CELO");
    expect(out).not.toContain("fee 0.431917980004319161 ETH");
  });

  test("a stablecoin charge reads in that stablecoin, with its own 6 decimals", () => {
    const out = formatQuoteLine(crossAssetLine(usdcNeed), SEPOLIA);
    expect(out).toContain("pays 0.853588 USDC on Celo Sepolia Testnet");
    expect(out).toContain("fee 0.129576 USDC");
    // 6 decimals read as 18 would print 0.000000000000853588.
    expect(out).not.toContain("0.000000000000853588");
  });

  test("the registration value stays in the registry chain's own token", () => {
    // The relay's funder pays it on Ethereum; only the escrow is the payer's.
    expect(formatQuoteLine(crossAssetLine(celoNeed), SEPOLIA)).toContain("value 0.000236604958884629 ETH");
  });

  test("a plain single-chain line says nothing about paying elsewhere", () => {
    const out = formatQuoteLine(registryLine({}), SEPOLIA);
    expect(out).not.toContain("pays");
    expect(out).toContain("fee 0.000000000000000003 ETH");
  });
});
