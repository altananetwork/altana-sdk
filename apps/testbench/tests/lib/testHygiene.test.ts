import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A mock remembers every call, so `calls[0]` only means "this test's first
 * call" if the thing accumulating was emptied since the last test.
 *
 * Shared across a `describe` body with nothing resetting it, `calls[0]` is the
 * FIRST test's first call forever, and every later test in the block asserts
 * against a call it did not make. The x402 block had this: a new test passed
 * alone and failed under its neighbours, with a diff pointing at code that was
 * not involved (2026-10-05). It can also pass for the wrong reason, which is
 * the half that never gets noticed.
 *
 * **The rule is the invariant, not the declaration site.** An earlier version
 * of this lint required the binding to be declared inside its own test, which
 * is one way to get the invariant and not the only one. A module-scoped
 * accumulator reset in a `beforeEach` satisfies it too, and sometimes has to
 * be module-scoped: the SDK's `sessionKeyRegistration.test.ts` is written to
 * from inside a module-level `mock.module` seam, so a per-test binding would
 * mean rewiring the seam per test. Dry-run against the SDK's suites, the
 * declaration rule produced 12 findings that were all legitimate resets (sdk,
 * 2026-10-05). So a `beforeEach` that assigns to the binding is accepted.
 *
 * **What this lint cannot check is whether a reset is CORRECT.** It sees that
 * a `beforeEach` writes to the name, not that it writes the right thing. That
 * gap is exactly where an absence-asserting test earns its keep: the SDK's
 * `sessionKeyRegistration.test.ts:353` is `expect(submitted).toBeNull()`, a
 * test that fails loudly if the reset ever stops working. The two are
 * complements, not alternatives. This lint fails when sharing is introduced;
 * that assertion fails when a reset breaks. Neither can do the other's job.
 *
 * A per-call factory is also fine, and is the fix where there is no seam to
 * keep: a fixture declared inside a `function` or arrow body is fresh for
 * every caller.
 *
 * **Candidates are matched broadly and resolved narrowly, on purpose.** Call
 * history is read through more than one shape: `mock.calls[0]` straight off a
 * `vi.fn`, and `calls[0]` off an array a stub captured into, which is the
 * convention across the SDK's suites (31 sites there, none of them
 * `mock.calls`). A lint matching only the shape its own repo happens to use
 * would walk another suite, match nothing and report clean, which is the lint
 * failing rather than the suite passing. So anything resembling an indexed
 * read of call history is a candidate, and a candidate this resolver cannot
 * attribute is REPORTED rather than skipped: a new shape shows up as
 * unchecked instead of silently passing.
 *
 * **Porting note.** A clean first run on a new tree is not the expected
 * outcome and is not the bar. Read findings as "decide the rule here" before
 * "fix these tests": a tree using `beforeEach` resets needs this version
 * rather than the declaration-only one, and a shape the resolver cannot name
 * needs `subjectOf` widened. `attributeOf` keeps a table of the shapes it has
 * actually been measured against, which is the honest record of its reach.
 */

/**
 * Excluded because it quotes the pattern it looks for, in prose and in its own
 * matcher, and would otherwise report itself. The only exclusion, named here
 * rather than expressed as a condition that could quietly grow.
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
 * The comments explaining this bug quote `calls[0]`, and matching candidates
 * broadly enough to be portable means matching them. Narrower than it looks:
 * a commented-out assertion is not running, so it cannot assert against the
 * wrong call either.
 */
function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/** Wrappers that are never the accumulator, so the leftmost name skips them. */
const NOT_SUBJECTS = new Set(["expect", "vi", "await", "return", "const", "let", "JSON", "Object", "Array", "String", "Number", "it", "test"]);

/**
 * The binding whose lifetime decides what index 0 means.
 *
 * For `mock.calls[n]` that is the mock's owner. For a captured array it is the
 * array, or the object holding it: `log.registry[0]!.calls[0]` is reached
 * through `log`, and `log` is what has to be per test, so the LEFTMOST name in
 * the expression is the subject rather than the inner `calls`. Attributing the
 * inner name was the earlier behaviour and made five of the SDK's findings
 * read as being about a variable that was not the problem.
 */
function subjectOf(line: string): string | undefined {
  const explicit = /vi\.mocked\(\s*(\w+)/.exec(line) ?? /\(\s*(\w+)\.\w+\s+as\b/.exec(line);
  if (explicit) return explicit[1];
  for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)[!?]?\s*(?=[.[])/g)) {
    const name = m[1]!;
    if (!NOT_SUBJECTS.has(name)) return name;
  }
  return undefined;
}

/**
 * Whether the enclosing file binds `subject` per test, or resets it per test.
 *
 * A parameter list counts as a declaration: a helper taking
 * `(calls: {...}[])` gets a fresh value from every caller by construction,
 * so there is no shared state to find.
 */
function isPerTest(body: string, file: string, subject: string): boolean {
  const s = subject.replace(/[$]/g, "\\$&");
  const declared = new RegExp(String.raw`\b(const|let)\s+(\{[^}]*\b${s}\b[^}]*\}|${s})\s*[=:]`).test(body);
  if (declared) return true;
  // A parameter, including a destructured or typed one.
  if (new RegExp(String.raw`\(([^)]*\b${s}\b\s*[:,)][^)]*)\)\s*(:|=>|\{)`).test(body)) return true;
  // Reset for every test: a beforeEach anywhere in the file that writes to it.
  const file_src = readFileSync(file, "utf8");
  const resets = new RegExp(String.raw`beforeEach\([\s\S]{0,400}?\b${s}\b\s*(=[^=]|\.length\s*=|\.mockClear|\.mockReset|\.splice)`);
  return resets.test(file_src);
}

describe("call history must mean this test's calls", () => {
  test("every indexed read of call history is per test, by binding or by reset", () => {
    const offenders: string[] = [];

    for (const file of testFiles("tests")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!CANDIDATE.test(line) || isComment(line)) return;
        const subject = subjectOf(line);
        if (!subject) {
          offenders.push(`${file}:${i + 1} could not be attributed, so it was not checked`);
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
        if (!isPerTest(lines.slice(start, i).join("\n"), file, subject)) {
          offenders.push(`${file}:${i + 1} (${subject}) is neither bound in its own test nor reset per test`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("the resolver attributes the whole suite, so an empty result means something", () => {
    // Without this, a matcher that quietly stopped matching would report a
    // clean suite, and on another repo a clean result would be the lint's
    // failure rather than the suite's. This is what makes the lint portable:
    // a tree whose convention `subjectOf` does not know fails HERE, and that
    // failure is the instruction to widen it, not to doubt the lint.
    const sites = testFiles("tests").flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => CANDIDATE.test(l) && !isComment(l)),
    );
    expect(sites.length).toBeGreaterThan(20);
    expect(sites.filter((l) => subjectOf(l) === undefined)).toEqual([]);
  });

  test("the shapes it has been measured against, named rather than assumed", () => {
    // Every row is a shape taken from a real suite, this one or the SDK's. A
    // resolver tested only against the shapes its own repo uses is how the
    // vacuous pass happened in the first place.
    const shapes: [string, string][] = [
      ["expect(vi.mocked(client.grantSession).mock.calls[0]![0]).toMatchObject({});", "client"],
      ["const opts = (client.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0];", "client"],
      ["expect(calls[0]).not.toHaveProperty('feeToken');", "calls"],
      ["const sent = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);", "fetchImpl"],
      ["expect(seam!.calls[0]).toEqual({});", "seam"],
      ["expect(submitted!.calls[0]).toEqual({});", "submitted"],
      ["expect(log.registry[0]!.calls[0]!).toMatchObject({});", "log"],
      ["function decodeXPayment(calls: { body: string }[]) { return calls[0]; }", "calls"],
    ];
    expect(shapes.map(([line]) => subjectOf(line))).toEqual(shapes.map(([, want]) => want));
  });
});
