/**
 * What "omitted" means for a session's allowed calls.
 *
 * This existed as a silent trap: the type said omitting `calls` allowed every
 * target, and it actually authorized none, so a session granted that way was
 * refused with `UnauthorizedCall` the first time its agent acted, long after the
 * grant had succeeded and been reported as granted.
 *
 * Proven on an anvil fork of chain 97 before the fix and after it:
 *
 *   calls omitted          -> UnauthorizedCall on every target
 *   calls [{to: DEAD}]     -> allowed to DEAD, refused elsewhere
 *   calls [{to: ANY_TARGET}] -> allowed everywhere
 */
import { describe, expect, test } from "bun:test";
import { ANY_TARGET, withDefaultCallPermissions } from "./internal/sessions.js";
import { parseEther } from "viem";

const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
const DAY_CAP = [{ limit: parseEther("0.001"), period: "day" as const }];

describe("omitting calls", () => {
  test("becomes the account's every-target wildcard", () => {
    const filled = withDefaultCallPermissions({ spend: DAY_CAP });
    expect(filled.calls).toEqual([{ to: ANY_TARGET }]);
  });

  test("uses the wildcard the account actually checks for", () => {
    // GuardedExecutor.sol: ANY_TARGET = 0x3232...32. If the account ever
    // changes it, this is the test that should fail.
    expect(ANY_TARGET).toBe("0x3232323232323232323232323232323232323232");
  });

  test("leaves the spend caps untouched", () => {
    const filled = withDefaultCallPermissions({ spend: DAY_CAP });
    expect(filled.spend).toEqual(DAY_CAP);
  });

  test("works for permissions with nothing in them at all", () => {
    expect(withDefaultCallPermissions({}).calls).toEqual([{ to: ANY_TARGET }]);
  });
});

describe("an explicit calls list is never widened", () => {
  test("one target is left as one target", () => {
    const given = { calls: [{ to: DEAD }], spend: DAY_CAP };
    expect(withDefaultCallPermissions(given)).toBe(given);
  });

  test("an EMPTY array still means nothing, and is not widened to everything", () => {
    // The dangerous direction. A caller who passes [] has said "nothing", and
    // turning that into "everything" would hand an agent the whole wallet.
    const given = { calls: [], spend: DAY_CAP };
    const filled = withDefaultCallPermissions(given);
    expect(filled.calls).toEqual([]);
    expect(filled.calls).not.toContainEqual({ to: ANY_TARGET });
  });

  test("a signature-only rule is left alone", () => {
    const given = { calls: [{ signature: "transfer(address,uint256)" }], spend: DAY_CAP };
    expect(withDefaultCallPermissions(given)).toBe(given);
  });

  test("the wildcard passed explicitly is left alone", () => {
    const given = { calls: [{ to: ANY_TARGET }] };
    expect(withDefaultCallPermissions(given)).toBe(given);
  });
});
