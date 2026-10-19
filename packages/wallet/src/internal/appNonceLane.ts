/**
 * A nonce lane per signing key, so an app's transactions never contend with the
 * relay's and two keys on one wallet never contend with each other.
 *
 * `IthacaAccount` counts nonces per sequence key: the upper 192 bits of a
 * nonce are the `seqKey` and the lower 64 a counter for that key alone
 * (`IthacaAccount.sol`, "4337-style 2D nonce sequences"). Intents in different
 * lanes never contend.
 *
 * Everything used to share lane 0. Measured from the Orchestrator's
 * `IntentExecuted` on 2026-10-17: a background KeyStore registration's two
 * funding intents took lane-0 counters 0 and 1 and an app's `execute` took a
 * counter in between them. The relay reserves no nonce for an intent it has not
 * mined, so any overlap in preparation gives two intents the same nonce and one
 * fails `InvalidNonce`
 * (`evidence/2026-10-17-nonce-lanes.md`).
 *
 * The registration's funding intent cannot be moved from the client: the relay
 * builds it itself with `nonce: None` hardcoded. So the SDK moves what it does
 * own -- the app's transactions -- and leaves lane 0 to the relay.
 *
 * One lane per **signing key**, not one lane for the SDK. Two keys on one
 * wallet then have nothing to coordinate, which is what makes this work across
 * processes: each instance only ever advances the lane of the key it holds, so
 * two agents with two session keys on one wallet can fire at the same moment
 * from two machines and neither needs to know the other exists. Two intents
 * signed by the SAME key still have to be sequenced, and that is what the
 * in-process queue below does -- it cannot help a key used from two places at
 * once, and the module does not pretend to.
 */

import { keccak256, type Address, type Hex, type PublicClient } from "viem";

/**
 * Marks a sequence key as one of this SDK's app lanes.
 *
 * The lane is derived from the signing key, so it could have been a bare hash.
 * The top 16 bits are fixed instead so that a nonce is recognisable as an app
 * lane at a glance in an explorer, and so the two hard requirements hold by
 * construction rather than by a check that could be dropped:
 *
 *  - **never 0**, which is the lane the relay allocates from;
 *  - **never `0xc1d0`**: the account reads that prefix as "this intent is
 *    multichain" and verifies a digest with the chain id left out
 *    (`IthacaAccount.sol`, `Orchestrator.sol`). A lane is not a free label.
 *
 * The remaining 176 bits carry the key, which is far more than enough to keep
 * two keys apart.
 */
export const APP_LANE_PREFIX = 0xa17an;

/**
 * The lane the key with this hash signs on: `0xa17a` followed by 176 bits of
 * `keccak(keyHash)`.
 *
 * Derived rather than assigned, so no registry of lanes has to be kept and two
 * SDK instances holding different keys agree on each other's lanes without
 * talking. Same key, same lane, on every chain and in every process.
 */
export function laneForKeyHash(keyHash: Hex): bigint {
  const hashed = BigInt(keccak256(keyHash));
  return (APP_LANE_PREFIX << 176n) | (hashed & ((1n << 176n) - 1n));
}

/** The full 256-bit nonce for `counter` on `lane`. */
export function laneNonce(lane: bigint, counter: bigint): bigint {
  return (lane << 64n) | counter;
}

/** Whether a nonce is on one of this SDK's app lanes. For tests and diagnostics. */
export function isAppLaneNonce(nonce: bigint): boolean {
  return nonce >> 240n === APP_LANE_PREFIX;
}

const GET_NONCE_ABI = [
  {
    name: "getNonce",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "seqKey", type: "uint192" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** chain:wallet:lane -> the next counter this process intends to use. */
const intended = new Map<string, bigint>();
/** chain:wallet:lane -> the tail of the queue of intents on that lane. */
const queue = new Map<string, Promise<unknown>>();

const stateKey = (chainId: number, wallet: Address, lane: bigint) =>
  `${chainId}:${wallet.toLowerCase()}:${lane.toString(16)}`;

/** Forgets what this process believed, so the next read comes from the chain. */
export function forgetAppLane(chainId: number, wallet: Address, lane: bigint): void {
  intended.delete(stateKey(chainId, wallet, lane));
}

/** What this process currently believes the next counter is. Tests only. */
export function intendedAppLaneCounter(
  chainId: number,
  wallet: Address,
  lane: bigint,
): bigint | undefined {
  return intended.get(stateKey(chainId, wallet, lane));
}

/**
 * The account's counter for the app lane, or undefined when the account cannot
 * answer.
 *
 * Undefined is the **fresh wallet** case and it matters: before the delegation
 * lands there is no account to ask, the read reverts, and an intent must not
 * carry a lane at all. The relay gives that first intent a random sequence key
 * of its own (`Account::random_nonce`), which collides with nothing, and from
 * the next intent on this read works.
 */
async function onChainCounter(
  publicClient: PublicClient,
  wallet: Address,
  lane: bigint,
): Promise<bigint | undefined> {
  try {
    const next = (await publicClient.readContract({
      address: wallet,
      abi: GET_NONCE_ABI,
      functionName: "getNonce",
      args: [lane],
    })) as bigint;
    // The account returns the whole next nonce, lane included.
    return next & ((1n << 64n) - 1n);
  } catch {
    return undefined;
  }
}

/**
 * What `send` hands back: its own result, and optionally the work that must
 * finish before the lane is free again.
 *
 * `settled` exists for a caller that returns before its intent is mined
 * (`execute`'s `noWait`). The lane is **not** released when the intent is sent,
 * only when it settles, because a lane's counter does not advance until the
 * intent executes: handing the next nonce out at submission time gives the
 * second intent a number the account has not reached, and the relay drops it
 * (qa, 2026-10-19: 8 of 10 failures on the live testnet relay).
 */
export type LaneOutcome<T> = { result: T; settled?: Promise<unknown> };

/**
 * Runs `send` with the nonce it should use, one intent at a time per wallet,
 * chain and lane, and holds the lane until that intent is **mined**.
 *
 * Why it queues: a lane's counter is strictly sequential, so counter N+1 cannot
 * execute before N. Handing out N and N+1 concurrently would not avoid a
 * collision, it would move it. Each intent therefore waits for the one before
 * it **on its own lane** — a different signing key is a different lane and
 * waits for nothing here. That is a wait between the caller's OWN back-to-back
 * transactions, which were always going to be ordered; it is not a wait on the
 * relay's background work, which is the thing that must never block an app.
 *
 * Why it holds until mined rather than until sent: the account's counter for a
 * lane advances when the intent executes, not when the relay accepts it, so
 * until then the next nonce is still the one in flight. That is how a single
 * EOA behaves, and it is the whole rule.
 *
 * `send` is given `undefined` when the account cannot be asked for a counter
 * (an undelegated wallet), meaning "send this without a nonce of ours", and
 * the lane it was given, so a caller can report or drop it without re-deriving
 * it.
 *
 * On `InvalidNonce` this process's belief is dropped, so the retry re-reads the
 * chain rather than insisting on a number the account has already refused.
 */
export async function withAppLaneNonce<T>(
  args: { publicClient: PublicClient; wallet: Address; chainId: number; keyHash: Hex },
  send: (nonce: bigint | undefined, lane: bigint) => Promise<LaneOutcome<T>>,
): Promise<T> {
  const lane = laneForKeyHash(args.keyHash);
  const key = stateKey(args.chainId, args.wallet, lane);
  const previous = queue.get(key);

  const run = (async (): Promise<LaneOutcome<T>> => {
    // Wait for the intent before this one ON THIS LANE to be MINED, however it
    // ended.
    // Another key's intents are on another lane and queue separately.
    if (previous) await previous.catch(() => undefined);

    const chainCounter = await onChainCounter(args.publicClient, args.wallet, lane);
    if (chainCounter === undefined) {
      // Undelegated: no lane, let the relay choose.
      forgetAppLane(args.chainId, args.wallet, lane);
      return await send(undefined, lane);
    }

    // The chain is the authority; this process's belief only ever runs ahead of
    // it, for an intent of ours that has not been mined yet.
    const believed = intended.get(key);
    const counter = believed !== undefined && believed > chainCounter ? believed : chainCounter;

    try {
      const outcome = await send(laneNonce(lane, counter), lane);
      intended.set(key, counter + 1n);
      return outcome;
    } catch (err) {
      forgetAppLane(args.chainId, args.wallet, lane);
      throw err;
    }
  })();

  // The queue's tail is "mined", not "sent": a caller that returns before its
  // intent lands hands back `settled`, and the next intent on this lane waits
  // for that too.
  const held = run
    .then(
      (outcome) => outcome.settled,
      () => undefined,
    )
    .catch(() => undefined);
  queue.set(key, held);
  void held.then(() => {
    if (queue.get(key) === held) queue.delete(key);
  });
  return run.then((outcome) => outcome.result);
}
