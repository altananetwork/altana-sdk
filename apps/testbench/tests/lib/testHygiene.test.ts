import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A mock remembers every call, so WHERE its fixture is declared decides what
 * `mock.calls[0]` means.
 *
 * Declared inside a test, `calls[0]` is that test's first call. Declared in a
 * `describe` body and shared, it is the FIRST test's first call forever, so
 * every later test in the block asserts against a grant it did not make. The
 * x402 block had this: a new test passed when run alone and failed under its
 * neighbours, with a diff pointing at code that was not involved
 * (2026-10-05). It can also pass for the wrong reason, which is the half that
 * never gets noticed.
 *
 * **A guard written for the file where it happened would not see the next
 * file.** So this resolves every indexed assertion in the suite rather than
 * the one that broke, and sdk's audit of their own suites is the control: the
 * same question asked there found no instances, which is what makes a clean
 * result here meaningful rather than vacuous.
 *
 * A per-call factory is fine and is the fix: a fixture declared inside a
 * `function` or arrow body is fresh for each caller, so only a declaration
 * sitting directly in a `describe` body is reported.
 *
 * **Candidates are matched broadly and resolved narrowly, on purpose.** Call
 * history gets read through more than one shape: `mock.calls[0]` straight off
 * a `vi.fn`, and `calls[0]` off an array a stub captured into, which is the
 * convention in the SDK's own suites (sdk, 2026-10-05: 31 sites, none of them
 * `mock.calls`). A lint that matched only the shape its own repo happens to
 * use would walk another suite, match nothing and report clean, which is the
 * lint failing rather than the suite passing. So anything that looks like an
 * indexed read of call history is a candidate, and a candidate this resolver
 * cannot attribute is REPORTED rather than skipped. A new shape therefore
 * shows up as unchecked instead of silently passing.
 */
/**
 * This file is excluded because it quotes the pattern it looks for, in prose
 * and in its own matcher, and would report itself. It is the only exclusion,
 * and it is named here rather than filtered by a condition that could quietly
 * grow to cover real files.
 */
const SELF = "testHygiene.test.ts";

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : /\.test\.tsx?$/.test(e.name) && e.name !== SELF ? [join(dir, e.name)] : [],
  );
}

/** Any line that reads call history by index, whatever shape it uses. */
const CANDIDATE = /calls\[\d/;

/**
 * Prose is not a call site.
 *
 * The comments explaining this very bug quote `calls[0]`, and matching
 * candidates broadly enough to be portable means matching them. Dropping
 * comment lines is narrower than it looks: a commented-out assertion is not
 * running, so it cannot assert against the wrong call either.
 */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/**
 * The binding an indexed read is accumulating through.
 *
 * For `mock.calls[n]` that is the mock's owner; for a captured array it is the
 * array itself, since that is the thing whose lifetime decides what index 0
 * means.
 *
 * On a nested read such as `outer[0]!.calls[0]` this attributes the inner
 * `calls` rather than `outer`. The report still names the right file and line,
 * and the verdict is still right, because a `calls` not bound in the test is
 * reached through something that is not either. The name in the message can
 * be the inner one, so read the line rather than the name.
 */
function subjectOf(line: string): string | undefined {
  const m =
    /vi\.mocked\(\s*(\w+)/.exec(line) ??
    /\(\s*(\w+)\.\w+\s+as\b/.exec(line) ??
    /\b(\w+)\.\w+\.mock\.calls\[/.exec(line) ??
    /\b(\w+)\.mock\.calls\[/.exec(line) ??
    /\b(\w+)!?\.calls\[/.exec(line) ??
    /\b(calls)\[/.exec(line);
  return m?.[1];
}

describe("a mock's fixture must be per test, not per describe block", () => {
  test("every indexed mock.calls[n] reads a fixture declared inside its own test", () => {
    const offenders: string[] = [];

    for (const file of testFiles("tests")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!CANDIDATE.test(line) || isComment(line)) return;
        const subject = subjectOf(line);
        if (!subject) {
          offenders.push(`${file}:${i + 1} could not be resolved, so it was not checked`);
          return;
        }
        let start = -1;
        for (let j = i - 1; j >= 0; j--) {
          if (/^\s*(test|it)\(/.test(lines[j]!)) {
            start = j;
            break;
          }
        }
        if (start < 0) {
          offenders.push(`${file}:${i + 1} (${subject}) sits outside any test`);
          return;
        }
        const body = lines.slice(start, i).join("\n");
        // Either a plain binding or a destructured one, e.g. const { client } = setup().
        const declared = new RegExp(String.raw`\b(const|let)\s+(\{[^}]*\b${subject}\b[^}]*\}|${subject})\s*[=:]`).test(body);
        if (!declared) offenders.push(`${file}:${i + 1} (${subject}) is declared outside its own test`);
      });
    }

    expect(offenders).toEqual([]);
  });

  test("the resolver actually resolves the suite, so an empty result means something", () => {
    // Without this a matcher that quietly stopped matching would report a
    // clean suite, and on another repo a clean result would be the lint's
    // failure rather than the suite's. It is what makes the lint portable: a
    // tree whose convention this resolver does not know fails HERE, and that
    // failure is the instruction to widen `subjectOf`, not to doubt the lint.
    const sites = testFiles("tests").flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => CANDIDATE.test(l) && !isComment(l)),
    );
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.filter((l) => subjectOf(l) === undefined)).toEqual([]);
  });
});
