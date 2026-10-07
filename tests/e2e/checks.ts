/**
 * A recorder that will not run a check whose subject was never created.
 *
 * QA found a passing assertion printed two lines under the failure that made its
 * subject impossible: the step that creates an agent transaction failed, and the
 * check for "Activity names the agent on its transaction" then searched a page
 * where no such transaction existed, found the name somewhere else, and passed.
 * A finding was written from it about a transaction that never happened.
 *
 * Asserting the precondition first is not enough, because that still runs the
 * check and still prints a result next to a failure as though the two were
 * independent. A check whose dependency did not pass must **not be evaluated**,
 * and must be reported as skipped, which is a third state and not a pass.
 *
 * So a step declares what it needs, and this decides whether to run it:
 *
 *     const checks = createChecks();
 *     await checks.step("S3", "the session is loaded", [], async () => …);
 *     await checks.step("S6", "the agent can spend", ["S3"], async () => …);
 *
 * If S3 did not pass, S6 never runs, and the summary says SKIP with the reason.
 *
 * ## A second rule, from the same day
 *
 * **A check that can emit two claims must not be able to emit contradictory
 * ones.** QA's phrasing, and it is sharper than anything either of us had that
 * morning. Two instances, hours apart and in different layers:
 *
 *  - A probe of mine printed "the race is real" while its own output two lines
 *    above said the cap was readable. Its verdict could not tell the two causes
 *    apart, so it picked the one it had been written expecting.
 *  - A check of QA's reported "no name field" and passed in the same breath,
 *    because it searched a stringified envelope for a name that was inside it as
 *    escaped text.
 *
 * In both, the summary line is what gets believed and the contradicting detail is
 * what gets scrolled past. Not mechanically preventable from here: this module
 * cannot know that a `detail` string disagrees with its own `pass`. What it can
 * do is make the honest shape the easy one, which is why `step` takes a function
 * returning the verdict rather than letting a caller record a pass and a message
 * that were computed separately.
 *
 * The practical version, for anyone writing a check in this directory: if the
 * detail you are about to print would read as evidence against the verdict you
 * are about to record, the check is wrong, not the detail.
 */

export type CheckState = "pass" | "fail" | "skip";

export type Check = {
  id: string;
  what: string;
  state: CheckState;
  detail: string;
};

/** What a step returns: whether it held, and what to print beside it. */
export type StepResult = boolean | { pass: boolean; detail?: string };

export function createChecks() {
  const results: Check[] = [];
  const byId = new Map<string, Check>();

  function push(id: string, what: string, state: CheckState, detail: string): Check {
    const check = { id, what, state, detail };
    results.push(check);
    byId.set(id, check);
    const label = state === "pass" ? "PASS" : state === "fail" ? "FAIL" : "SKIP";
    console.log(`  ${label}  ${id.padEnd(5)} ${what}${detail ? `  ${detail}` : ""}`);
    return check;
  }

  /** The dependencies that did not pass, which is why a step is skipped. */
  function unmet(needs: readonly string[]): string[] {
    return needs.filter((id) => byId.get(id)?.state !== "pass");
  }

  return {
    results,

    /** Record a result directly, for a check with nothing before it. */
    record(id: string, what: string, pass: boolean, detail = ""): boolean {
      push(id, what, pass ? "pass" : "fail", detail);
      return pass;
    },

    /**
     * Run a check, unless something it needs did not pass.
     *
     * A throw inside is a failure of this check rather than of the run, because
     * a step that blows up has still told us something, and losing the summary
     * loses every other result with it.
     */
    async step(
      id: string,
      what: string,
      needs: readonly string[],
      run: () => Promise<StepResult> | StepResult,
    ): Promise<boolean> {
      const missing = unmet(needs);
      if (missing.length > 0) {
        push(id, what, "skip", `not run: ${missing.join(", ")} did not pass`);
        return false;
      }
      try {
        const outcome = await run();
        const pass = typeof outcome === "boolean" ? outcome : outcome.pass;
        const detail = typeof outcome === "boolean" ? "" : (outcome.detail ?? "");
        push(id, what, pass ? "pass" : "fail", detail);
        return pass;
      } catch (err) {
        /* The summary line is a summary, so the error itself goes to stderr in
           full. A truncated message is how a failure gets explained by the
           wrong text: QA spent an evening on an ExceededSpendLimit that came
           from a different step's tail, and 120 characters of someone else's
           message reads exactly like a cause. */
        console.error(`\n  ${id} threw:`);
        console.error(err);
        push(id, what, "fail", `threw: ${(err as Error).message.slice(0, 120)}`);
        return false;
      }
    },

    /** Whether a check passed, for control flow that is not itself a check. */
    passed(id: string): boolean {
      return byId.get(id)?.state === "pass";
    },

    /**
     * Print the summary and return the exit code.
     *
     * A skip is not a pass and the count says so separately, because a run that
     * skipped half its checks and reported "5/5 passed" would be the same lie in
     * a different place.
     */
    summarise(title: string): number {
      const line = "=".repeat(43);
      console.log(`\n${line}\n${title}\n${line}`);
      for (const r of results) {
        const label = r.state === "pass" ? "PASS" : r.state === "fail" ? "FAIL" : "SKIP";
        console.log(`  ${label}  ${r.id.padEnd(5)} ${r.what}`);
      }
      const passed = results.filter((r) => r.state === "pass").length;
      const failed = results.filter((r) => r.state === "fail").length;
      const skipped = results.filter((r) => r.state === "skip").length;
      console.log(`\n  ${passed}/${results.length} passed` + (skipped ? `, ${skipped} skipped` : ""));
      if (skipped) console.log("  a skipped check proves nothing; it was not run");
      return failed > 0 || skipped > 0 ? 1 : 0;
    },
  };
}
