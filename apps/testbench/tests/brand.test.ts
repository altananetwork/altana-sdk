import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/* Brand Kit v2.0 hard rules, enforced on the source: no em dashes, no monospace
   face, no eyebrows. Nothing else in the ecosystem lints these today. */

const ROOT = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css|html|md)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, "src")), join(ROOT, "index.html"), join(ROOT, "README.md")].filter((f) => {
  try {
    statSync(f);
    return true;
  } catch {
    return false;
  }
});

describe("brand rules", () => {
  test("no em dashes in source, styles, markup or docs", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("—"));
    expect(offenders).toEqual([]);
  });

  test("no monospace font family", () => {
    const re = /font-family\s*:[^;]*(monospace|ui-monospace|Geist Mono|SF Mono|Menlo|Courier)/i;
    const offenders = files.filter((f) => re.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("no eyebrow or kicker patterns", () => {
    const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
    const rules = css.match(/\{[^}]*\}/g) ?? [];
    const eyebrow = rules.filter((r) => /text-transform\s*:\s*uppercase/.test(r) && /letter-spacing\s*:\s*0?\.[0-9]+em/.test(r));
    expect(eyebrow).toEqual([]);
    const names = files.filter((f) => /\b(eyebrow|kicker)\b/i.test(readFileSync(f, "utf8")));
    expect(names).toEqual([]);
  });

  test("critical red is never a fill", () => {
    const css = files.filter((f) => f.endsWith("components.css")).map((f) => readFileSync(f, "utf8")).join("\n");
    const danger = css.match(/\.btn-danger\s*\{[^}]*\}/)?.[0] ?? "";
    expect(danger).toMatch(/background:\s*transparent/);
  });
});
