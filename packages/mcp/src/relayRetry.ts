/**
 * Retrying a transaction the relay refused before broadcasting it.
 *
 * The failure this exists for, measured live on chain 97 and written up in
 * `evidence/2026-10-29-g4-live-diagnosis.md`: a permission is granted, the grant
 * lands on chain, the agent acts within seconds, and the relay reports the
 * bundle FAILED with status 300 and no receipt anywhere. Nothing was broadcast.
 * The same call, with the same session and the same key, succeeds minutes later.
 *
 * So the first action after a grant can race what the relay is able to see. A
 * person who grants a permission, sends it, and asks their agent to act is in
 * that window, which is why this is a product problem and not a test artefact.
 *
 * Two things make the retry correct rather than a replay:
 *
 *   The SDK has already discarded its view of the nonce lane by the time it
 *   throws, so the next attempt re-reads the counter from the chain and builds
 *   a fresh intent. Re-presenting the same intent is what the live run did, by
 *   retrying immediately, and both attempts carried counter 0 into the same
 *   stale view.
 *
 *   The wait is between attempts rather than before the first, so nothing is
 *   slower in the normal case.
 */

/**
 * How long to wait before each retry.
 *
 * Bounded on purpose. Three waits totalling 21 seconds is long enough for a
 * relay that is a block or two behind and short enough that an agent is not
 * silently stuck: past that, something other than lag is wrong and saying so is
 * more use than waiting longer.
 */
export const RELAY_BACKOFF_MS: readonly number[] = [3000, 6000, 12000];

/**
 * Was this the relay refusing to broadcast, rather than a transaction that ran
 * and failed?
 *
 * Matched on the SDK's message, which is the only thing that crosses the
 * package boundary today. Two phrases together rather than one, so an unrelated
 * message that happens to contain the word "FAILED" is not retried.
 *
 * This is the weakest part of the change and worth replacing with a typed error
 * from the SDK, which is queued in
 * `evidence/2026-10-29-backend-follow-ups.md`. Being narrow is the safer way to
 * be wrong: a transient failure that is not retried costs one refusal the agent
 * can repeat, while retrying a definitive refusal would hide it.
 */
export function isRelayDroppedBeforeBroadcast(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("with no receipt on any chain") &&
    message.includes("refused before being broadcast")
  );
}

export type RelayRetryOutcome<T> = {
  value: T;
  /** How many times the call was presented, including the one that worked. */
  attempts: number;
  /** Total time spent waiting between attempts. */
  waitedMs: number;
};

/**
 * Run something that talks to the relay, retrying only the refusal above.
 *
 * Anything else is rethrown untouched on the first attempt. A refusal over a
 * spend limit, a wallet that cannot pay the fee, a revoked key: those are
 * answers, and waiting changes none of them.
 */
export async function withRelayBackoff<T>(
  run: () => Promise<T>,
  opts: {
    backoffMs?: readonly number[];
    /** Injected by tests, so a 21 second bound does not cost 21 seconds. */
    sleep?: (ms: number) => Promise<void>;
    /** Told before each wait, so an operator can see it happening. */
    onWait?: (args: { attempt: number; waitMs: number; message: string }) => void;
  } = {},
): Promise<RelayRetryOutcome<T>> {
  const backoff = opts.backoffMs ?? RELAY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { value: await run(), attempts: attempt, waitedMs };
    } catch (err) {
      const waitMs = backoff[attempt - 1];
      // Out of waits, or not the failure this retries: the caller gets the
      // error, and it is the last one rather than the first, because the last
      // is the one that describes the state things were actually left in.
      if (waitMs === undefined || !isRelayDroppedBeforeBroadcast(err)) throw err;
      opts.onWait?.({
        attempt,
        waitMs,
        message: err instanceof Error ? err.message : String(err),
      });
      await sleep(waitMs);
      waitedMs += waitMs;
    }
  }
}

/** One line for a result, so the agent can say what happened rather than guess. */
export function describeRetries(outcome: { attempts: number; waitedMs: number }): string | undefined {
  if (outcome.attempts <= 1) return undefined;
  const seconds = Math.round(outcome.waitedMs / 100) / 10;
  return (
    `The relay refused to broadcast this ${outcome.attempts - 1} time(s) before it went ` +
    `through, which usually means it had not yet caught up with a recent grant. ` +
    `Waited ${seconds}s in total and rebuilt the transaction each time. Nothing was sent twice.`
  );
}
