/**
 * Certified-skills discovery for the Altana MCP server.
 *
 * The Altana skills registry (github.com/altananetwork/skills) publishes an
 * `index.json` describing certified protocol skills an agent can use on a
 * wallet — each entry pointing at a `SKILL.md` playbook plus its scope,
 * suggested spend cap, and certification scorecard. This module fetches and
 * caches that index, matches it against a keyword query, and retrieves a
 * single skill's full content with an integrity check.
 *
 * The registry URL defaults to the main branch of the public repo and is
 * overridable via ALTANA_SKILLS_INDEX_URL (mirroring the ALTANA_CHAIN
 * env-config style). The SKILL.md fetch URL is derived from the index URL's
 * directory plus the entry's `path`, so a mirror or a pinned commit works
 * without extra configuration.
 *
 * The pure functions (deriveSkillUrl, matchSkills, sha256Hex,
 * verifySkillContent) carry the logic and are unit-tested without a network;
 * the fetching wrappers (fetchIndex, searchSkills, getSkill) build on them.
 */

import { createHash } from "node:crypto";

const DEFAULT_INDEX_URL =
  "https://raw.githubusercontent.com/altananetwork/skills/main/index.json";

/** The registry index URL in effect for this process. */
export function skillsIndexUrl(): string {
  return process.env.ALTANA_SKILLS_INDEX_URL || DEFAULT_INDEX_URL;
}

export type SkillScope = {
  contracts?: string[];
  spendCapSuggested?: string;
};

export type SkillScorecard = {
  trials?: number;
  passed?: number;
  medianSecondsToComplete?: number;
  scopeViolations?: number;
  certifiedAt?: string;
};

export type SkillEntry = {
  id: string;
  name: string;
  description: string;
  chain: string;
  tags: string[];
  publisher: string;
  version: string;
  path: string;
  sha256: string;
  scope?: SkillScope;
  scorecard?: SkillScorecard;
};

export type SkillsIndex = {
  version: number;
  skills: SkillEntry[];
};

/**
 * Resolve the absolute URL of a skill's SKILL.md from the index URL and the
 * entry's `path`. The path is treated as relative to the directory that
 * holds index.json (e.g. `.../skills/main/index.json` +
 * `skills/x/SKILL.md` -> `.../skills/main/skills/x/SKILL.md`).
 */
export function deriveSkillUrl(indexUrl: string, path: string): string {
  return new URL(path, indexUrl).toString();
}

/** Lowercase hex sha256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify fetched SKILL.md bytes against the index entry's sha256. Throws if
 * they differ. Comparison is case-insensitive on the hex digest.
 */
export function verifySkillContent(
  bytes: Uint8Array,
  expectedSha256: string,
): void {
  const actual = sha256Hex(bytes);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Skill content failed integrity verification: computed sha256 ` +
        `${actual} does not match the registry's ${expectedSha256}. ` +
        `The SKILL.md may have been tampered with; not returning it.`,
    );
  }
}

export type SkillMatch = SkillEntry & { matchScore: number };

/**
 * Case-insensitive keyword match over name + description + tags. The query is
 * split into words; a skill matches if at least one word appears, and results
 * are ranked by how many distinct query words matched (descending), ties
 * broken by original index order (stable).
 */
export function matchSkills(index: SkillsIndex, query: string): SkillMatch[] {
  const words = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0),
    ),
  );
  if (words.length === 0) return [];

  const scored: SkillMatch[] = [];
  for (const skill of index.skills) {
    const haystack = [
      skill.name,
      skill.description,
      ...(skill.tags ?? []),
    ]
      .join(" ")
      .toLowerCase();
    const matchScore = words.filter((w) => haystack.includes(w)).length;
    if (matchScore > 0) scored.push({ ...skill, matchScore });
  }

  // Stable sort by score descending; Array.prototype.sort is stable in modern
  // engines, so equal scores keep their registry order.
  return scored.sort((a, b) => b.matchScore - a.matchScore);
}

// ---------- fetching (index cache + network wrappers) ----------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache: { url: string; index: SkillsIndex; fetchedAt: number } | undefined;

/**
 * Fetch and parse the registry index, caching it in memory for 5 minutes. The
 * cache is keyed on the resolved URL so an env override invalidates it.
 */
export async function fetchIndex(): Promise<SkillsIndex> {
  const url = skillsIndexUrl();
  const now = Date.now();
  if (cache && cache.url === url && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.index;
  }

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Could not reach the Altana skills registry at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Altana skills registry returned HTTP ${res.status} for ${url}.`,
    );
  }
  let index: SkillsIndex;
  try {
    index = (await res.json()) as SkillsIndex;
  } catch (err) {
    throw new Error(
      `Altana skills registry at ${url} did not return valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!index || !Array.isArray(index.skills)) {
    throw new Error(
      `Altana skills registry at ${url} is missing a "skills" array.`,
    );
  }

  cache = { url, index, fetchedAt: now };
  return index;
}

/** Test-only: clear the in-memory index cache. */
export function clearIndexCache(): void {
  cache = undefined;
}

export type SearchResult = {
  id: string;
  name: string;
  description: string;
  chain: string;
  publisher: string;
  scope?: SkillScope;
  scorecard?: SkillScorecard;
};

/** Search the registry and project each match to its agent-facing summary. */
export async function searchSkills(query: string): Promise<SearchResult[]> {
  const index = await fetchIndex();
  return matchSkills(index, query).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    chain: s.chain,
    publisher: s.publisher,
    scope: s.scope,
    scorecard: s.scorecard,
  }));
}

export type SkillDetail = {
  id: string;
  name: string;
  version: string;
  sha256: string;
  scope?: SkillScope;
  scorecard?: SkillScorecard;
  content: string;
};

/**
 * Fetch one skill by id, verify its SKILL.md against the registry sha256, and
 * return the verified content plus scope/scorecard. Throws if the id is
 * unknown or the content fails integrity verification.
 */
export async function getSkill(id: string): Promise<SkillDetail> {
  const index = await fetchIndex();
  const entry = index.skills.find((s) => s.id === id);
  if (!entry) {
    throw new Error(
      `No skill with id "${id}" in the Altana registry. ` +
        `Call search_skills to find valid ids.`,
    );
  }

  const url = deriveSkillUrl(skillsIndexUrl(), entry.path);
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Could not fetch SKILL.md for "${id}" at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Fetching SKILL.md for "${id}" returned HTTP ${res.status} (${url}).`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifySkillContent(bytes, entry.sha256);

  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    sha256: entry.sha256,
    scope: entry.scope,
    scorecard: entry.scorecard,
    content: new TextDecoder().decode(bytes),
  };
}
