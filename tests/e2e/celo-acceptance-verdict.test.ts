/**
 * The acceptance run's verdict rule, on the cases that matter: the subset run
 * that reported PASS for a key that never reached Celo, and the ones around it.
 */
import { describe, expect, test } from "bun:test";
import { verdictOf, type MirrorState, type StepStatus } from "./celo-acceptance-verdict.js";

/** The six steps of a run, by id, so a case reads like the run it describes. */
const run = (statuses: Record<string, StepStatus>) =>
  ["1", "2a", "2b", "3", "4", "5", "6"].map((id) => ({ status: statuses[id] ?? "SKIPPED" }));
const all = (status: StepStatus) => run({ "1": status, "2a": status, "2b": status, "3": status, "4": status, "5": status, "6": status });
const final = (steps: ReturnType<typeof run>, mirror: MirrorState) => verdictOf({ steps, kind: "final", mirror });

describe("the acceptance verdict", () => {
  test("a full run with every step passed and the mirror checked is a PASS", () => {
    expect(final(all("PASS"), "checked")).toBe("PASS");
  });

  test("one failed step is a FAIL, whatever the mirror did", () => {
    const steps = run({ "1": "PASS", "2a": "PASS", "2b": "FAIL", "3": "PASS" });
    expect(final(steps, "checked")).toBe("FAIL");
    expect(final(steps, "pending")).toBe("FAIL");
    expect(final(steps, "none")).toBe("FAIL");
  });

  test("the mid-run report is never a verdict, even with nothing failed", () => {
    expect(verdictOf({ steps: all("PASS"), kind: "partial", mirror: "checked" })).toBe("PARTIAL");
  });

  /**
   * The run this rule was written for: infra's 2026-10-28 run of
   * `ACCEPT_STEPS=1,2b,3` on wallet 0x6c8119E4…, which registered a key on
   * Ethereum Sepolia, started the proof into the Celo mirror, printed PASS,
   * and was killed twenty minutes before the proof landed.
   */
  test("a subset run that skipped step 5 with its proof still in flight is PARTIAL, not PASS", () => {
    const steps = run({ "1": "PASS", "2b": "PASS", "3": "PASS" });
    expect(final(steps, "pending")).toBe("PARTIAL");
  });

  test("the same run is a PASS once the proof is seen to land", () => {
    const steps = run({ "1": "PASS", "2b": "PASS", "3": "PASS" });
    expect(final(steps, "checked")).toBe("PASS");
  });

  test("a run that started no proof answers for none", () => {
    expect(final(run({ "1": "PASS", "2a": "PASS" }), "none")).toBe("PASS");
  });

  test("a step caught mid-flight is PARTIAL", () => {
    expect(final(run({ "1": "PASS", "2a": "PENDING" }), "none")).toBe("PARTIAL");
  });

  test("a run where nothing ran proves nothing", () => {
    expect(final(all("SKIPPED"), "none")).toBe("PARTIAL");
    expect(verdictOf({ steps: [], kind: "final", mirror: "none" })).toBe("PARTIAL");
  });
});
