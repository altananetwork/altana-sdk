import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address } from "viem";
import { CELO_SEPOLIA, NATIVE_TOKEN, SEPOLIA } from "./config.js";
import { formatQuoteLine, withBalances, type QuoteLine } from "./quoteSession.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers eth_getBalance per public RPC host; anything else is refused. */
function mockBalances(byUrl: Record<string, bigint>) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url).replace(/\/$/, "");
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string }) => {
      asked.push(`${u} ${req.method}`);
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1" };
      if (req.method !== "eth_getBalance" || !(u in byUrl)) throw new Error(`unexpected ${req.method} to ${u}`);
      return { jsonrpc: "2.0", id: req.id, result: numberToHex(byUrl[u]!) };
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
    const asked = mockBalances({ [CELO_SEPOLIA.publicRpcUrl.replace(/\/$/, "")]: 10n });
    const quote = await withBalances([registryLine({ fundedFromChainId: CELO_SEPOLIA.chainId })], [CELO_SEPOLIA]);
    expect(quote.balances).toEqual([
      { chainId: CELO_SEPOLIA.chainId, address: WALLET, symbol: CELO_SEPOLIA.chain.nativeCurrency.symbol, balance: 10n, needed: 5n, sufficient: true },
    ]);
    expect(asked.some((a) => a.startsWith(SEPOLIA.publicRpcUrl.replace(/\/$/, "")))).toBe(false);
  });

  test("a line without a source chain (a direct EOA write) is charged to the registry chain", async () => {
    mockBalances({ [SEPOLIA.publicRpcUrl.replace(/\/$/, "")]: 1n });
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
