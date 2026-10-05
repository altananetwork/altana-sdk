import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/*
 * A lint, not a unit test. Cross-chain was the one panel that set an error from
 * `e.message` instead of `relayReason(e)`, so it showed viem's generic wrapper
 * plus a kilobyte of echoed request and hid the relay's actual answer. Every
 * other panel already did the right thing, which is exactly why nobody noticed:
 * one file out of seven, and only visible by failing it live (qa, 2026-10-05).
 *
 * The bench's whole claim about errors is that it shows what the chain or the
 * relay actually said. One panel opting out undoes that claim wherever it is
 * the panel being demonstrated.
 */

/**
 * **A guard scoped to where the last bug was found will keep missing the next
 * one.** That is the general rule and it is not specific to this lint; it is
 * written here because this is where it was learned and where narrowing the
 * scope would next be tempting.
 *
 * The evidence: the first version walked `src/components`, because that is
 * where the instance that prompted it happened to be. It then missed the
 * loudest instance of the very bug it was written for. `lib/crossChain.ts` put
 * an undecoded message into a step detail, which renders under the failed step
 * *and* in the activity log, while the panel's error box the lint did reach was
 * the quiet surface nobody reads (qa, 2026-10-05). Widening it to all of `src`
 * immediately found two more, one of which could have stopped the anchor-race
 * retry firing at all.
 *
 * So this walks everything that can produce text a person reads, and a test
 * below asserts it reaches `lib/crossChain.ts`, so narrowing it again fails
 * loudly rather than silently.
 */
const SRC = join(__dirname, "..", "..", "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "test") continue; // fakes and helpers, not product code
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Reading an error's `.message` raw is fine for a local throw and wrong for
 * anything that came back from the relay. The two look identical in the
 * source, so a site that means the first says so with a `local-validation:`
 * comment on the line above, and anything else fails this lint.
 *
 * The comment is the point: it forces a decision per site rather than letting
 * the next one be decided by whichever line was copied.
 */
describe("every panel reports the relay's own reason", () => {
  test("a raw .message is either decoded or declared local", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/instanceof\s+Error\s*\?\s*\w+\.message/.test(line)) return;
        const declared = (lines[i - 1] ?? "").includes("local-validation:");
        if (!declared) offenders.push(`${file.split("/").pop()}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "use relayReason(err), or mark the line local-validation: with why",
    ).toEqual([]);
  });

  test("every component that catches from the client decodes with relayReason", () => {
    const offenders = sources(SRC).filter((f) => {
      const src = readFileSync(f, "utf8");
      const catchesFromClient = /client\.\w+\(/.test(src) && /catch\s*\(/.test(src);
      return catchesFromClient && !src.includes("relayReason");
    });
    expect(offenders.map((f) => f.split("/").pop())).toEqual([]);
  });

  test("it reaches lib, which is where the loud surface was", () => {
    // The step detail in crossChain.ts renders under the failed step and in
    // the activity log. A components-only lint could not see it.
    const files = sources(SRC).map((f) => f.split("/").slice(-2).join("/"));
    expect(files).toContain("lib/crossChain.ts");
    expect(files).toContain("lib/proveMirror.ts");
  });

  test("the lint would have caught the bug it was written for", () => {
    // Guards the guard: a panel that sets an error from a raw message with no
    // declaration is exactly what CrossChainPanel did.
    const offending = ['} catch (e) {', '  setError(e instanceof Error ? e.message : String(e));', '}'];
    const declared = ['} catch (e) {', '  // local-validation: a form error.', '  setError(e instanceof Error ? e.message : String(e));', '}'];
    const flags = (lines: string[]) =>
      lines.some((line, i) => /instanceof\s+Error\s*\?\s*\w+\.message/.test(line) && !(lines[i - 1] ?? "").includes("local-validation:"));
    expect(flags(offending)).toBe(true);
    expect(flags(declared)).toBe(false);
  });
});
