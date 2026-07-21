import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  deriveSkillUrl,
  sha256Hex,
  verifySkillContent,
  matchSkills,
  type SkillsIndex,
} from "./skills.js";

const INDEX: SkillsIndex = {
  version: 1,
  skills: [
    {
      id: "pancakeswap-trading",
      name: "PancakeSwap Trading",
      description:
        "Buys and sells tokens on PancakeSwap, in and out of positions fast.",
      chain: "bnb",
      tags: ["trading", "dex", "pancakeswap", "swap", "meme"],
      publisher: "Altana",
      version: "1.0.0",
      path: "skills/pancakeswap-trading/SKILL.md",
      sha256: "deadbeef",
    },
    {
      id: "venus-lending",
      name: "Venus Lending",
      description: "Supply and borrow assets on the Venus money market.",
      chain: "bnb",
      tags: ["lending", "defi", "venus"],
      publisher: "Altana",
      version: "1.0.0",
      path: "skills/venus-lending/SKILL.md",
      sha256: "cafe",
    },
    {
      id: "x402-payments",
      name: "x402 Payments",
      description: "Pay HTTP 402 payment challenges with a session key.",
      chain: "bnb",
      tags: ["payments", "x402", "http"],
      publisher: "Altana",
      version: "1.0.0",
      path: "skills/x402-payments/SKILL.md",
      sha256: "f00d",
    },
  ],
};

// ---------- deriveSkillUrl --------------------------------------------------

test("deriveSkillUrl resolves the path against the index directory", () => {
  expect(
    deriveSkillUrl(
      "https://raw.githubusercontent.com/altananetwork/skills/main/index.json",
      "skills/pancakeswap-trading/SKILL.md",
    ),
  ).toBe(
    "https://raw.githubusercontent.com/altananetwork/skills/main/skills/pancakeswap-trading/SKILL.md",
  );
});

test("deriveSkillUrl honors a pinned-commit / mirror index URL", () => {
  expect(
    deriveSkillUrl(
      "https://example.test/mirror/abc123/index.json",
      "skills/venus-lending/SKILL.md",
    ),
  ).toBe("https://example.test/mirror/abc123/skills/venus-lending/SKILL.md");
});

// ---------- sha256Hex / verifySkillContent ---------------------------------

test("sha256Hex matches node:crypto over the same bytes", () => {
  const bytes = new TextEncoder().encode("# PancakeSwap Trading\n");
  const expected = createHash("sha256").update(bytes).digest("hex");
  expect(sha256Hex(bytes)).toBe(expected);
});

test("verifySkillContent passes when the digest matches", () => {
  const bytes = new TextEncoder().encode("hello skill");
  const sha = createHash("sha256").update(bytes).digest("hex");
  expect(() => verifySkillContent(bytes, sha)).not.toThrow();
});

test("verifySkillContent is case-insensitive on the hex digest", () => {
  const bytes = new TextEncoder().encode("hello skill");
  const sha = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  expect(() => verifySkillContent(bytes, sha)).not.toThrow();
});

test("verifySkillContent throws on a tampered payload", () => {
  const bytes = new TextEncoder().encode("hello skill");
  const wrong = createHash("sha256")
    .update(new TextEncoder().encode("different"))
    .digest("hex");
  expect(() => verifySkillContent(bytes, wrong)).toThrow(
    /failed integrity verification/,
  );
});

// ---------- matchSkills -----------------------------------------------------

test("matchSkills matches on the name", () => {
  const res = matchSkills(INDEX, "pancakeswap");
  expect(res.map((s) => s.id)).toEqual(["pancakeswap-trading"]);
});

test("matchSkills matches on a tag", () => {
  const res = matchSkills(INDEX, "lending");
  expect(res.map((s) => s.id)).toEqual(["venus-lending"]);
});

test("matchSkills matches on the description", () => {
  const res = matchSkills(INDEX, "borrow");
  expect(res.map((s) => s.id)).toEqual(["venus-lending"]);
});

test("matchSkills is case-insensitive", () => {
  const res = matchSkills(INDEX, "PANCAKESWAP");
  expect(res.map((s) => s.id)).toEqual(["pancakeswap-trading"]);
});

test("matchSkills requires at least one word to match", () => {
  expect(matchSkills(INDEX, "nonexistentprotocol")).toEqual([]);
});

test("matchSkills returns [] for an empty query", () => {
  expect(matchSkills(INDEX, "   ")).toEqual([]);
});

test("matchSkills ranks by number of distinct matching words", () => {
  // "swap" hits only pancakeswap; "trading" hits only pancakeswap; "defi"
  // hits only venus. Query touching two pancakeswap fields should still be a
  // single skill, but a query spanning both skills ranks the multi-word hit
  // first.
  const res = matchSkills(INDEX, "trading swap payments");
  // pancakeswap-trading matches "trading" and "swap" (2); x402-payments
  // matches "payments" (1).
  expect(res.map((s) => s.id)).toEqual([
    "pancakeswap-trading",
    "x402-payments",
  ]);
  expect(res[0]!.matchScore).toBe(2);
  expect(res[1]!.matchScore).toBe(1);
});

test("matchSkills counts each distinct word once, not repeats", () => {
  const res = matchSkills(INDEX, "swap swap swap");
  expect(res).toHaveLength(1);
  expect(res[0]!.matchScore).toBe(1);
});
