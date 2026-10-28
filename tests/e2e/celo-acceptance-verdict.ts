/**
 * The verdict rule of the Celo acceptance run, kept out of the run itself so
 * it can be tested without a chain, a relay or eight CELO.
 *
 * It is its own file because of one false PASS. On 2026-10-28 a subset run
 * (`ACCEPT_STEPS=1,2b,3`) printed "Verdict: PASS" while the thing step 3 had
 * started — the proof that carries the newly registered key into the Celo
 * mirror — was still twenty minutes from landing, and the process was killed
 * before it landed. A key that existed in the Ethereum Sepolia KeyStore and
 * never reached Celo was reported as a pass.
 *
 * So PASS means two things now, not one: every step that ran passed, AND
 * nothing this run started was left for someone else to find out about.
 */

/** A step's outcome. `PENDING` is a step the report caught mid-flight. */
export type StepStatus = "PASS" | "FAIL" | "SKIPPED" | "PENDING";
export type Verdict = "PASS" | "FAIL" | "PARTIAL";

/**
 * What became of the proof into the Celo mirror:
 *
 * - `none`     — none was ever started, so there is nothing to answer for.
 * - `checked`  — one was started and seen to land, by step 5 or by the wait
 *                that stands in for step 5 when it is not in the run.
 * - `pending`  — one was started and this run does not know how it ended.
 */
export type MirrorState = "none" | "checked" | "pending";

export function verdictOf(args: {
  steps: readonly { status: StepStatus }[];
  /** `partial`: the mid-run report printed after step 4, never a verdict. */
  kind: "partial" | "final";
  mirror: MirrorState;
}): Verdict {
  const { steps, kind, mirror } = args;
  if (steps.some((s) => s.status === "FAIL")) return "FAIL";
  if (kind === "partial") return "PARTIAL";
  // The false PASS this rule was written for: a proof in flight that nobody
  // watched. Not a FAIL — the run was not asked to prove the mirror — but
  // never a PASS either, because the key may not be on Celo at all.
  if (mirror === "pending") return "PARTIAL";
  // A step still running when the report is written was not proven either.
  if (steps.some((s) => s.status === "PENDING")) return "PARTIAL";
  // And nothing ran at all: an ACCEPT_STEPS naming no step proves nothing,
  // which is the same false PASS with every step skipped instead of one.
  if (!steps.some((s) => s.status === "PASS")) return "PARTIAL";
  return "PASS";
}
