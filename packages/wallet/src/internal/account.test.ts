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
import { feeFromPrepared, nativeNeededFromPrepared } from "./relay.js";

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

describe("nativeNeededFromPrepared", () => {
  const NATIVE = "0x0000000000000000000000000000000000000000" as const;
  const TOKEN = "0x00000000000000000000000000000000000000ee" as const;

  test("a funded wallet: the fee plus the registration fee, not the registration fee alone", () => {
    const prepared = { context: { quote: { quotes: [{ intent: { totalPaymentMaxAmount: 700n } }] } } };
    expect(nativeNeededFromPrepared(prepared, { fee: 700n, value: 200n, feeToken: NATIVE })).toEqual({
      nativeNeeded: 900n,
      nativeNeededFromRelay: false,
    });
  });

  test("a short wallet: the relay's native asset deficit figure is used", () => {
    const prepared = {
      context: { quote: { quotes: [{ assetDeficits: [{ address: null, required: 950n, deficit: 950n }] }] } },
    };
    expect(nativeNeededFromPrepared(prepared, { fee: 700n, value: 200n, feeToken: NATIVE })).toEqual({
      nativeNeeded: 950n,
      nativeNeededFromRelay: true,
    });
  });

  test("a token deficit is ignored for the native need", () => {
    const prepared = {
      context: { quote: { quotes: [{ assetDeficits: [{ address: TOKEN, required: 5n, deficit: 5n }] }] } },
    };
    expect(nativeNeededFromPrepared(prepared, { fee: 700n, value: 200n, feeToken: TOKEN })).toEqual({
      nativeNeeded: 200n,
      nativeNeededFromRelay: false,
    });
  });

  test("never below fee plus value, even if the relay's figure is lower", () => {
    const prepared = {
      context: { quote: { quotes: [{ assetDeficits: [{ address: null, required: 100n, deficit: 100n }] }] } },
    };
    expect(nativeNeededFromPrepared(prepared, { fee: 700n, value: 200n, feeToken: NATIVE }).nativeNeeded).toBe(900n);
  });
});
