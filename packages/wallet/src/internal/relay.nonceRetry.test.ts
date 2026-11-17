/**
 * Retrying a prepare the account rejected for its nonce.
 *
 * The relay reads the account's nonce on chain at `latest` and remembers
 * nothing between requests, so a wallet's second operation is prepared against
 * a chain state that does not include its first one. Asking again is the fix:
 * the relay re-reads the chain, and nothing was signed or sent in between.
 *
 * What these pin down is the shape of the retry, not the relay: it retries only
 * InvalidNonce, it is bounded, and the caller sees the last error rather than a
 * swallowed one.
 */
import { describe, expect, test } from "bun:test";
import { NONCE_RETRY_DELAYS_MS, retryInvalidNonce } from "./relay.js";

/** The error shape the relay's InvalidNonce arrives in, under viem's wrapper. */
const invalidNonce = () =>
  Object.assign(new Error("Invalid parameters were provided to the RPC method"), {
    cause: Object.assign(new Error("RPC Request failed.\nURL: https://relay\nRequest body: {...}"), {
      details: "InvalidNonce(InvalidNonce)",
    }),
  });

const NO_WAIT = [0, 0, 0];

describe("retryInvalidNonce", () => {
  test("a prepare that works first time is called once", async () => {
    let calls = 0;
    const result = await retryInvalidNonce(async () => {
      calls += 1;
      return "prepared";
    }, NO_WAIT);
    expect(result).toBe("prepared");
    expect(calls).toBe(1);
  });

  // The live case: one rejection, then the chain has caught up. Four
  // back-to-back operations on Celo Sepolia each behaved exactly like this.
  test("one InvalidNonce then success: the caller never sees the rejection", async () => {
    let calls = 0;
    const result = await retryInvalidNonce(async () => {
      calls += 1;
      if (calls === 1) throw invalidNonce();
      return "prepared";
    }, NO_WAIT);
    expect(result).toBe("prepared");
    expect(calls).toBe(2);
  });

  test("it keeps asking while the account keeps rejecting, up to the bound", async () => {
    let calls = 0;
    await expect(
      retryInvalidNonce(async () => {
        calls += 1;
        throw invalidNonce();
      }, NO_WAIT),
    ).rejects.toThrow("Invalid parameters");
    // One attempt per delay, plus the last attempt whose error is the caller's.
    expect(calls).toBe(NO_WAIT.length + 1);
  });

  test("the error the caller sees is the last attempt's, not a summary", async () => {
    let calls = 0;
    const thrown = await retryInvalidNonce(async () => {
      calls += 1;
      const e: any = invalidNonce();
      e.attempt = calls;
      throw e;
    }, NO_WAIT).then(
      () => undefined,
      (e: any) => e,
    );
    expect(thrown.attempt).toBe(4);
  });

  test("any other rejection is not retried: it is the caller's answer at once", async () => {
    for (const details of ["fee token not supported: 0xabc", "quote expired", "intent reverted: 0x"]) {
      let calls = 0;
      await expect(
        retryInvalidNonce(async () => {
          calls += 1;
          throw Object.assign(new Error("RPC Request failed"), { details });
        }, NO_WAIT),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  test("an error with no relay reason at all is not retried either", async () => {
    let calls = 0;
    await expect(
      retryInvalidNonce(async () => {
        calls += 1;
        throw new Error("Invalid parameters were provided to the RPC method");
      }, NO_WAIT),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("the shipped delays are bounded and give the chain a block or two", () => {
    expect(NONCE_RETRY_DELAYS_MS.length).toBe(3);
    expect(NONCE_RETRY_DELAYS_MS.every((d) => d > 0)).toBe(true);
    // Celo blocks are ~1s and the first retry alone has always been enough, so
    // the whole budget stays well under a caller's patience.
    expect(NONCE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15_000);
  });
});
