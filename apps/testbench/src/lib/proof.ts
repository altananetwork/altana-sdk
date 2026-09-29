/**
 * The milestone checklist the Proof view renders.
 *
 * `public/proof.json` is generated from qa's `MATRIX.md` by
 * `scripts/build-proof.mjs`, so the matrix stays the single source of truth
 * and nobody keeps a second copy in step by hand. The shape is deliberately
 * close to the matrix's own table, and an unrecognised status is carried
 * through as `other` with its words intact rather than being reclassified: a
 * status this file does not know about must still be visible.
 */

export type ProofState =
  | "proven-live"
  | "proven-fork"
  | "proven-mixed"
  | "unproven"
  | "missing"
  | "blocked"
  | "other";

export type ProofLink = { label: string; url: string };

export type ProofRow = {
  /** The milestone item, for example "2a", or a spine step such as "S3". */
  item: string;
  title: string;
  /** The matrix's own status words, shown as written. */
  status: string;
  state: ProofState;
  /** Which relay proved it: railway, local, fork, or empty when none was involved. */
  relay: string;
  note: string;
  links: ProofLink[];
};

export type ProofSection = { title: string; rows: ProofRow[] };

export type ProofFile = {
  generatedAt: string;
  source: string;
  matrixUpdated?: string;
  sections: ProofSection[];
};

const STATES: ProofState[] = [
  "proven-live",
  "proven-fork",
  "proven-mixed",
  "unproven",
  "missing",
  "blocked",
  "other",
];

/** Accepts anything and returns a file the view can render, or undefined. */
export function parseProof(raw: unknown): ProofFile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.sections)) return undefined;
  const sections = r.sections.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const sec = s as Record<string, unknown>;
    if (typeof sec.title !== "string" || !Array.isArray(sec.rows)) return [];
    return [{ title: sec.title, rows: sec.rows.flatMap(parseRow) }];
  });
  return {
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
    source: typeof r.source === "string" ? r.source : "",
    ...(typeof r.matrixUpdated === "string" ? { matrixUpdated: r.matrixUpdated } : {}),
    sections,
  };
}

function parseRow(raw: unknown): ProofRow[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  if (typeof r.item !== "string" || typeof r.title !== "string") return [];
  const state = STATES.includes(r.state as ProofState) ? (r.state as ProofState) : "other";
  const links = Array.isArray(r.links)
    ? r.links.flatMap((l) => {
        if (!l || typeof l !== "object") return [];
        const link = l as Record<string, unknown>;
        return typeof link.label === "string" && typeof link.url === "string"
          ? [{ label: link.label, url: link.url }]
          : [];
      })
    : [];
  return [
    {
      item: r.item,
      title: r.title,
      status: typeof r.status === "string" ? r.status : "",
      state,
      relay: typeof r.relay === "string" ? r.relay : "",
      note: typeof r.note === "string" ? r.note : "",
      links,
    },
  ];
}

export const STATE_LABELS: Record<ProofState, string> = {
  "proven-live": "Proven live",
  "proven-fork": "Proven on a fork",
  "proven-mixed": "Partly live, partly fork",
  unproven: "Not proven",
  missing: "Missing",
  blocked: "Blocked by a gate",
  other: "See the status",
};

/** How many rows are in each state, in the order the summary shows them. */
export function countStates(file: ProofFile): { state: ProofState; count: number }[] {
  const counts = new Map<ProofState, number>();
  for (const section of file.sections) {
    for (const row of section.rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  }
  return STATES.flatMap((state) => {
    const count = counts.get(state);
    return count ? [{ state, count }] : [];
  });
}

/**
 * Rows that carry a public transaction link. A fork transaction has no
 * explorer, so the matrix does not link one, which makes "has a link" a good
 * proxy for "a third party can check this".
 */
export function rowsWithPublicProof(file: ProofFile): ProofRow[] {
  return file.sections.flatMap((s) => s.rows.filter((r) => r.links.length > 0));
}
