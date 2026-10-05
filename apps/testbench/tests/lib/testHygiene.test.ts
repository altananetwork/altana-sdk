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

/** The variable an indexed `mock.calls[n]` assertion reads. */
function subjectOf(line: string): string | undefined {
  const m =
    /vi\.mocked\(\s*(\w+)/.exec(line) ??
    /\(\s*(\w+)\.\w+\s+as\b/.exec(line) ??
    /\b(\w+)\.\w+\.mock\.calls\[/.exec(line) ??
    /\b(\w+)\.mock\.calls\[/.exec(line);
  return m?.[1];
}

describe("a mock's fixture must be per test, not per describe block", () => {
  test("every indexed mock.calls[n] reads a fixture declared inside its own test", () => {
    const offenders: string[] = [];

    for (const file of testFiles("tests")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("mock.calls[")) return;
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
    // Without this, a regex that matched nothing would report a clean suite.
    const sites = testFiles("tests").flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.includes("mock.calls[")),
    );
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.filter((l) => subjectOf(l) === undefined)).toEqual([]);
  });
});
