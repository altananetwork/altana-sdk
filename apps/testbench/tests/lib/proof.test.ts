import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ageInDays,
  countStates,
  isStale,
  parseProof,
  rowsWithPublicProof,
  type ProofFile,
} from "../../src/lib/proof";

const ROOT = join(__dirname, "..", "..");
const GENERATOR = join(ROOT, "scripts", "build-proof.mjs");

const MATRIX = `# Matrix

Last updated: 2026-09-28

## Milestone 1

| # | Item | Status | Relay | Evidence / note |
|---|---|---|---|---|
| 1a | Contracts deployed | **Proven (live)** | - | Plan-verified |
| 1c | Published to npm | Missing | - | npm is on 0.9.0 |
| 1b | Cross-chain registration | Blocked by gate | railway | G1 |
| 1b | Fee-currency oracle | **Proven (live)** on staging, blocked by gate for Railway | local | G1 |

## The spine, step by step

| Step | What it proves | Status | Relay | Evidence |
|---|---|---|---|---|
| S2a | Execute paying CELO | **Proven (live)** | railway | [\`0xeb47…\`](https://sepolia.celoscan.io/tx/0xeb47) |
| S2b | Execute paying a stablecoin | **USDC Proven (live)**; others **Proven (fork)** | local, fork | See the 2a rows |
| S3 | Register from Celo | **Proven (fork, funder check stubbed)** | fork | Stub on |
| S9 | Something new | Investigating | - | A status this view has not seen |
`;

function generate(matrix = MATRIX): ProofFile {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const matrixPath = join(dir, "MATRIX.md");
  const outPath = join(dir, "proof.json");
  writeFileSync(matrixPath, matrix);
  execFileSync("node", [GENERATOR, matrixPath, outPath], { stdio: "pipe" });
  return JSON.parse(readFileSync(outPath, "utf8")) as ProofFile;
}

describe("build-proof", () => {
  test("reads the matrix's tables into sections and rows", () => {
    const file = generate();
    expect(file.matrixUpdated).toBe("2026-09-28");
    expect(file.sections.map((s) => s.title)).toEqual(["Milestone 1", "The spine, step by step"]);
    expect(file.sections[0]!.rows.map((r) => r.item)).toEqual(["1a", "1c", "1b", "1b"]);
  });

  test("a status qualified inside the parentheses is not read as live", () => {
    // "Proven (fork, funder check stubbed)" is the one step that has never
    // worked live. A green badge on it would be the exact failure the
    // walkthrough exists to avoid.
    const s3 = generate().sections[1]!.rows.find((r) => r.item === "S3")!;
    expect(s3.state).toBe("proven-fork");
    expect(s3.status).toContain("funder check stubbed");
  });

  test("a status saying proven and blocked is shown as blocked, not green", () => {
    // "Proven (live) on staging, blocked by gate for Railway" is not something
    // a third party can check yet, and the proof view must not claim it is.
    const row = generate().sections[0]!.rows.find((r) => r.title === "Fee-currency oracle")!;
    expect(row.state).toBe("blocked");
    expect(row.status).toContain("Proven (live) on staging");
  });

  test("a status naming both live and fork is neither on its own", () => {
    const s2b = generate().sections[1]!.rows.find((r) => r.item === "S2b")!;
    expect(s2b.state).toBe("proven-mixed");
  });

  test("a status this code has never seen keeps its words instead of vanishing", () => {
    const s9 = generate().sections[1]!.rows.find((r) => r.item === "S9")!;
    expect(s9.state).toBe("other");
    expect(s9.status).toBe("Investigating");
  });

  test("links in the evidence cell are carried through, with the markup stripped", () => {
    const s2a = generate().sections[1]!.rows.find((r) => r.item === "S2a")!;
    expect(s2a.links).toEqual([{ label: "0xeb47…", url: "https://sepolia.celoscan.io/tx/0xeb47" }]);
    expect(s2a.title).toBe("Execute paying CELO");
  });

  test("a dash in the relay column means no relay, not the character", () => {
    expect(generate().sections[0]!.rows[0]!.relay).toBe("");
  });

  test("header and separator rows are not items", () => {
    const items = generate().sections.flatMap((s) => s.rows.map((r) => r.item));
    expect(items).not.toContain("#");
    expect(items).not.toContain("Step");
  });

  test("the generator is committed and runnable", () => {
    expect(existsSync(GENERATOR)).toBe(true);
  });
});

describe("parseProof", () => {
  test("junk is rejected rather than half-rendered", () => {
    expect(parseProof(null)).toBeUndefined();
    expect(parseProof({ sections: "no" })).toBeUndefined();
    expect(parseProof("{}")).toBeUndefined();
  });

  test("a malformed row is dropped and the rest survive", () => {
    const file = parseProof({
      generatedAt: "now",
      source: "x",
      sections: [{ title: "s", rows: [{ item: "1a", title: "t" }, { nope: true }] }],
    })!;
    expect(file.sections[0]!.rows).toHaveLength(1);
    expect(file.sections[0]!.rows[0]).toMatchObject({ item: "1a", state: "other", links: [] });
  });

  test("an unknown state falls back to other rather than breaking the badge", () => {
    const file = parseProof({
      sections: [{ title: "s", rows: [{ item: "1a", title: "t", state: "invented" }] }],
    })!;
    expect(file.sections[0]!.rows[0]!.state).toBe("other");
  });
});

describe("summaries", () => {
  test("counts every state present, and none that is not", () => {
    const counts = countStates(generate());
    expect(counts.find((c) => c.state === "proven-live")?.count).toBe(2);
    expect(counts.find((c) => c.state === "blocked")?.count).toBe(2);
    expect(counts.find((c) => c.state === "missing")?.count).toBe(1);
    expect(counts.find((c) => c.state === "unproven")).toBeUndefined();
  });

  test("only rows with a public transaction count as publicly checkable", () => {
    expect(rowsWithPublicProof(generate()).map((r) => r.item)).toEqual(["S2a"]);
  });
});

describe("the committed proof.json", () => {
  test("is present and parses, so the view has something to render", () => {
    const path = join(ROOT, "public", "proof.json");
    expect(existsSync(path)).toBe(true);
    const file = parseProof(JSON.parse(readFileSync(path, "utf8")));
    expect(file).toBeDefined();
    expect(file!.sections.length).toBeGreaterThan(0);
  });
});

describe("staleness", () => {
  const file = (generatedAt: string): ProofFile => ({ generatedAt, source: "x", sections: [] });
  const NOW = new Date("2026-10-05T12:00:00Z");

  test("a snapshot generated today is not stale", () => {
    expect(isStale(file("2026-10-05T09:00:00Z"), NOW)).toBe(false);
    expect(ageInDays(file("2026-10-05T09:00:00Z"), NOW)).toBe(0);
  });

  test("a week-old snapshot is, which is what nobody noticed on the dry run", () => {
    expect(ageInDays(file("2026-09-29T11:00:00Z"), NOW)).toBe(6);
    expect(isStale(file("2026-09-29T11:00:00Z"), NOW)).toBe(true);
  });

  test("an unreadable or absent timestamp is not reported as fresh", () => {
    expect(ageInDays(file("not a date"), NOW)).toBeUndefined();
    expect(ageInDays(file(""), NOW)).toBeUndefined();
    // Unknown is not stale either: it says nothing rather than crying wolf.
    expect(isStale(file(""), NOW)).toBe(false);
  });
});
