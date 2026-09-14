/**
 * Account reads: accountHasKey reads "no key" from a revert or a codeless
 * address, but throws on a transport failure so a revoke never reports a
 * chain clean because its RPC was down. Plus the fee read from a relay quote.
 */
import { describe, expect, test } from "bun:test";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  type PublicClient,
} from "viem";
import { accountHasKey, getKeys } from "./account.js";
import { feeFromPrepared, feeTokenRequiredFromRaw } from "./relay.js";
import { nativeNeed, type QuoteLine } from "../quoteSession.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

const client = (readContract: () => Promise<unknown>) => ({ readContract }) as unknown as PublicClient;

function wrapped(cause: Error) {
  return new ContractFunctionExecutionError(cause as any, {
    abi: [],
    functionName: "getKey",
    contractAddress: WALLET,
  });
}

describe("accountHasKey", () => {
  test("true when getKey answers", async () => {
    expect(await accountHasKey(client(async () => ({ publicKey: "0x" })), WALLET, HASH)).toBe(true);
  });

  test("false when the account reverts (key not held)", async () => {
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: "getKey" });
    await expect(accountHasKey(client(async () => { throw wrapped(revert); }), WALLET, HASH)).resolves.toBe(false);
  });

  test("throws when the RPC is unreachable", async () => {
    const http = new HttpRequestError({ url: "http://127.0.0.1:9" });
    await expect(
      accountHasKey(client(async () => { throw wrapped(http); }), WALLET, HASH),
    ).rejects.toBeInstanceOf(ContractFunctionExecutionError);
  });
});

describe("getKeys", () => {
  test("returns keys and key hashes", async () => {
    const r = await getKeys(client(async () => [[{ keyType: 2 }], [HASH]]), WALLET);
    expect(r.keyHashes).toEqual([HASH]);
    expect(r.keys).toHaveLength(1);
  });
});

describe("feeFromPrepared", () => {
  test("sums totalPaymentMaxAmount and deficits across quotes, decoded or hex", () => {
    const prepared = {
      context: {
        quote: {
          quotes: [
            { intent: { totalPaymentMaxAmount: 1000n }, feeTokenDeficit: 0n },
            { intent: { totalPaymentMaxAmount: "0x10" }, feeTokenDeficit: "0x2" },
          ],
        },
      },
    };
    expect(feeFromPrepared(prepared)).toEqual({ fee: 1016n, feeTokenDeficit: 2n });
  });

  test("throws when the response has no quote", () => {
    expect(() => feeFromPrepared({ context: {} })).toThrow(/no quote/);
  });
});

describe("feeTokenRequiredFromRaw", () => {
  test("sums the relay's optional feeTokenRequired across quotes (hex on the wire)", () => {
    const raw = { context: { quote: { quotes: [{ feeTokenRequired: "0x384" }, { feeTokenRequired: "0x64" }] } } };
    expect(feeTokenRequiredFromRaw(raw)).toBe(1000n);
  });

  test("undefined when any quote leaves it out (older relay), never a partial sum", () => {
    const raw = { context: { quote: { quotes: [{ feeTokenRequired: "0x384" }, {}] } } };
    expect(feeTokenRequiredFromRaw(raw)).toBeUndefined();
    expect(feeTokenRequiredFromRaw(undefined)).toBeUndefined();
  });
});

describe("nativeNeed", () => {
  const NATIVE = "0x0000000000000000000000000000000000000000" as const;
  const base: QuoteLine = { chainId: 11155111, kind: "registry", payer: WALLET, feeToken: NATIVE, fee: 700n, value: 200n };

  test("the relay's requirement wins over the registration fee plus fee", () => {
    expect(nativeNeed({ ...base, feeTokenRequired: 1234n })).toBe(1234n);
  });

  test("without it, the fee plus the value the calls carry, not the value alone", () => {
    expect(nativeNeed(base)).toBe(900n);
  });

  test("a token fee leaves only the native value", () => {
    expect(nativeNeed({ ...base, feeToken: "0x00000000000000000000000000000000000000ee", feeTokenRequired: 5n })).toBe(200n);
  });
});
