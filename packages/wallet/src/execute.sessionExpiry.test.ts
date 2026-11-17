/**
 * The check `execute` makes before it sends anything, for a session whose own
 * expiry has already passed.
 *
 * Over a fetch that fails loudly if it is touched at all: the point of the
 * check is that no round trip happens, and a mocked relay that answered
 * politely would hide the difference. The sentence itself is pinned in
 * errors.test.ts; what cannot be read from there is that it is raised without
 * the wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { execute } from "./execute.js";
import { altanaErrorOf } from "./errors.js";
import type { Session } from "./internal/sessions.js";

const WALLET = "0x73548b3900000000000000000000000000000000" as Address;
const CALLS = [{ to: "0x2222222222222222222222222222222222222222" as Address, value: 1n, data: "0x" as Hex }];

/** Doris's case: a key that ran out at 12:28 UTC and was used at 15:20. */
const EXPIRED_AT = Math.floor(Date.UTC(2026, 10, 9, 12, 28, 0) / 1000);
/** Well past any run of this test. */
const LIVE_UNTIL = Math.floor(Date.UTC(2099, 0, 1, 0, 0, 0) / 1000);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sessionWith(expiry: number): Session {
  const signer = createPrivateKeySigner();
  return { walletAddress: WALLET, signer, publicKey: signer.publicKey, permissions: {}, expiry };
}

/** A wire that is not allowed to be used, and counts the attempts anyway. */
function forbiddenWire(): { touches: () => number } {
  let touches = 0;
  globalThis.fetch = (async () => {
    touches += 1;
    throw new Error("the wire was touched");
  }) as typeof fetch;
  return { touches: () => touches };
}

describe("a session that has already expired", () => {
  test("it fails with the expiry's own time, and nothing is sent", async () => {
    const wire = forbiddenWire();
    const err = await execute(sessionWith(EXPIRED_AT), CALLS, { network: CELO_SEPOLIA }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const mapped = altanaErrorOf(err);
    expect(mapped?.code).toBe("session_expired");
    expect(mapped?.message).toBe("This session expired at 12:28 UTC. Grant a new session to continue.");
    expect(wire.touches()).toBe(0);
    // The addresses and the exact times are for the log, not the screen.
    expect(mapped?.detail).toContain(WALLET);
    expect(mapped?.detail).toContain("2026-11-09T12:28:00.000Z");
    expect(mapped?.message).not.toContain(WALLET);
  });

  test("a session still in date is not held back by the check", async () => {
    const wire = forbiddenWire();
    const err = await execute(sessionWith(LIVE_UNTIL), CALLS, { network: CELO_SEPOLIA }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // It got as far as the relay, which is all this asserts: the failure is
    // the forbidden wire's, not the expiry check's.
    expect(wire.touches()).toBeGreaterThan(0);
    expect(altanaErrorOf(err)?.code).not.toBe("session_expired");
  });

  test("a session granted without an expiry is never overdue", async () => {
    const wire = forbiddenWire();
    await execute(sessionWith(0), CALLS, { network: CELO_SEPOLIA }).catch(() => undefined);
    expect(wire.touches()).toBeGreaterThan(0);
  });
});
