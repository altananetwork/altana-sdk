import { describe, expect, test } from "bun:test";
import {
  describeRetries,
  isRelayDroppedBeforeBroadcast,
  RELAY_BACKOFF_MS,
  withRelayBackoff,
} from "./relayRetry.js";

/**
 * The message the SDK throws when the relay refuses to broadcast, copied from
 * `execute.ts`'s `silentlyDroppedMessage` with the values from the live
 * failure. Copied rather than imported because what crosses the package
 * boundary at runtime is the text, so the text is what has to be matched; a
 * test that imported the builder would pass even if the wording drifted apart.
 */
const DROPPED =
  "The relay reported this transaction FAILED (status code 300) with no receipt on any " +
  "chain, so it never reached a block: it was refused before being broadcast, not " +
  "reverted on chain. Bundle 0x997c9a29 on chain 97, nonce 7303946000000000000008032 " +
  "— counter 0 on lane 0xa17adf0c74c77cc4f58f4bd7c3eb0fb1bac351c55ff95056. " +
  "If the counter is ahead of what `getNonce` reports for that lane, the account never " +
  "reached this nonce and the intent was dropped for it; the SDK has already discarded " +
  "its view of the lane, so retrying re-reads the chain.";

/** A relay that refuses the first `failures` presentations and then works. */
function fakeRelay(failures: number) {
  let presentations = 0;
  const nonces: number[] = [];
  return {
    get presentations() {
      return presentations;
    },
    get nonces() {
      return nonces;
    },
    present: async () => {
      presentations += 1;
      // A fresh counter each time, which is what re-reading the lane gives.
      nonces.push(presentations - 1);
      if (presentations <= failures) throw new Error(DROPPED);
      return { status: "CONFIRMED", transactionHash: `0x${"ab".repeat(32)}` };
    },
  };
}

/** No real waiting: the bound is 21 seconds and the test should not be. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("isRelayDroppedBeforeBroadcast", () => {
  test("recognises the refusal it exists for", () => {
    expect(isRelayDroppedBeforeBroadcast(new Error(DROPPED))).toBe(true);
  });

  test("does not retry a wallet that cannot pay the fee", () => {
    // Waiting changes nothing about this, and retrying would hide it.
    const deficit = new Error(
      "The relay rejected the request to submit the call: quote has asset deficits and is expected to fail",
    );
    expect(isRelayDroppedBeforeBroadcast(deficit)).toBe(false);
  });

  test("does not retry a spend limit refusal, which is an answer", () => {
    expect(
      isRelayDroppedBeforeBroadcast(new Error("ExceededSpendLimit: the session's daily cap is spent")),
    ).toBe(false);
  });

  test("needs both phrases, so a stray FAILED is not enough", () => {
    expect(isRelayDroppedBeforeBroadcast(new Error("the transaction FAILED"))).toBe(false);
    expect(
      isRelayDroppedBeforeBroadcast(new Error("FAILED with no receipt on any chain")),
    ).toBe(false);
  });

  test("copes with something thrown that is not an Error", () => {
    expect(isRelayDroppedBeforeBroadcast("nope")).toBe(false);
    expect(isRelayDroppedBeforeBroadcast(undefined)).toBe(false);
  });
});

describe("withRelayBackoff", () => {
  test("a relay that works first time is not waited for at all", async () => {
    const relay = fakeRelay(0);
    const { waits, sleep } = recordingSleep();
    const outcome = await withRelayBackoff(relay.present, { sleep });

    expect(outcome.attempts).toBe(1);
    expect(outcome.waitedMs).toBe(0);
    expect(waits).toEqual([]);
    expect(relay.presentations).toBe(1);
  });

  test("one refusal is waited out, and the call goes through", async () => {
    const relay = fakeRelay(1);
    const { waits, sleep } = recordingSleep();
    const outcome = await withRelayBackoff(relay.present, { sleep });

    expect(outcome.value).toMatchObject({ status: "CONFIRMED" });
    expect(outcome.attempts).toBe(2);
    expect(waits).toEqual([3000]);
    expect(outcome.waitedMs).toBe(3000);
  });

  test("the waits grow, and each attempt is a fresh presentation", async () => {
    // The live failure presented the same counter twice. Each attempt here
    // carries a new one, which is what re-reading the lane gives.
    const relay = fakeRelay(3);
    const { waits, sleep } = recordingSleep();
    const outcome = await withRelayBackoff(relay.present, { sleep });

    expect(outcome.attempts).toBe(4);
    expect(waits).toEqual([3000, 6000, 12000]);
    expect(outcome.waitedMs).toBe(21000);
    expect(relay.nonces).toEqual([0, 1, 2, 3]);
    expect(new Set(relay.nonces).size).toBe(4);
  });

  test("it is bounded, and gives up with the last error rather than the first", async () => {
    // Past the bound something other than lag is wrong, and saying so is more
    // use than waiting longer.
    const relay = fakeRelay(99);
    const { waits, sleep } = recordingSleep();
    await expect(withRelayBackoff(relay.present, { sleep })).rejects.toThrow(
      /refused before being broadcast/,
    );
    expect(relay.presentations).toBe(RELAY_BACKOFF_MS.length + 1);
    expect(waits).toEqual([...RELAY_BACKOFF_MS]);
  });

  test("anything else is rethrown on the first attempt, untouched", async () => {
    let presentations = 0;
    const definitive = new Error("ExceededSpendLimit: the session's daily cap is spent");
    const { waits, sleep } = recordingSleep();

    await expect(
      withRelayBackoff(
        async () => {
          presentations += 1;
          throw definitive;
        },
        { sleep },
      ),
    ).rejects.toThrow(definitive);

    expect(presentations).toBe(1);
    expect(waits).toEqual([]);
  });

  test("it says when it is waiting, so an operator can see it", async () => {
    const relay = fakeRelay(2);
    const { sleep } = recordingSleep();
    const told: { attempt: number; waitMs: number }[] = [];
    await withRelayBackoff(relay.present, {
      sleep,
      onWait: ({ attempt, waitMs }) => told.push({ attempt, waitMs }),
    });
    expect(told).toEqual([
      { attempt: 1, waitMs: 3000 },
      { attempt: 2, waitMs: 6000 },
    ]);
  });

  test("the backoff can be overridden, which is how the bound is tested", async () => {
    const relay = fakeRelay(1);
    const { waits, sleep } = recordingSleep();
    await withRelayBackoff(relay.present, { sleep, backoffMs: [50] });
    expect(waits).toEqual([50]);
  });

  test("waiting for real is the default, and it is the bound we expect", () => {
    // Nobody should have to read the module to know what an agent might sit
    // through.
    expect([...RELAY_BACKOFF_MS]).toEqual([3000, 6000, 12000]);
    expect(RELAY_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBe(21000);
  });
});

describe("describeRetries", () => {
  test("says nothing when nothing was retried", () => {
    expect(describeRetries({ attempts: 1, waitedMs: 0 })).toBeUndefined();
  });

  test("names the refusals, the wait, and that nothing was sent twice", async () => {
    const line = describeRetries({ attempts: 3, waitedMs: 9000 })!;
    expect(line).toContain("2 time(s)");
    expect(line).toContain("9s");
    expect(line).toContain("recent grant");
    // The question an agent would otherwise have to ask.
    expect(line).toContain("Nothing was sent twice");
  });
});
