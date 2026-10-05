import { useEffect, useState } from "react";
import {
  ageInDays,
  countStates,
  isStale,
  parseProof,
  rowsWithPublicProof,
  STATE_LABELS,
  type ProofFile,
  type ProofState,
} from "../lib/proof";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";

const TONE: Record<ProofState, "success" | "warning" | "accent" | "error" | undefined> = {
  "proven-live": "success",
  "proven-fork": "accent",
  "proven-mixed": "accent",
  unproven: "warning",
  missing: "error",
  blocked: "warning",
  other: undefined,
};

/**
 * The milestone checklist, rendered from `public/proof.json`.
 *
 * The file is generated from qa's `MATRIX.md`, which is the source of truth, so
 * this view never states a status of its own: it shows the matrix's own words
 * next to a badge, and it says when the file was generated so nobody reads a
 * stale checklist as today's state.
 */
export function ProofPanel({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [file, setFile] = useState<ProofFile>();
  const [problem, setProblem] = useState<string>();
  const [onlyPublic, setOnlyPublic] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchImpl("/proof.json");
        if (!res.ok) throw new Error(`proof.json answered ${res.status}`);
        const parsed = parseProof(await res.json());
        if (cancelled) return;
        if (!parsed) {
          setProblem("proof.json is not in the shape this view expects.");
          return;
        }
        setFile(parsed);
      } catch (err) {
        // local-validation: fetching a static file from public/, never the relay.
        if (!cancelled) setProblem(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  const publicRows = file ? rowsWithPublicProof(file) : [];

  return (
    <div className="panel">
      <h2>Proof</h2>
      <p className="lead">
        The milestone checklist, with the evidence for each item. It is generated from the verification matrix
        that qa keeps, so what you read here is what the matrix says, not a second opinion.
      </p>

      {problem && (
        <div className="banner error" role="alert">
          {problem} Generate it with node scripts/build-proof.mjs, which reads celo-harness/MATRIX.md.
        </div>
      )}

      {file && (
        <>
          <Card title="Where this stands">
            <div className="stack">
              <div className="row">
                {countStates(file).map(({ state, count }) => (
                  <Badge key={state} tone={TONE[state]}>
                    {count} {STATE_LABELS[state].toLowerCase()}
                  </Badge>
                ))}
              </div>
              <p className="muted">
                {publicRows.length} items carry a public transaction anyone can check. A fork transaction has no
                explorer, so a fork-proven item has no link here by design.
              </p>
              <div className="row">
                <Button onClick={() => setOnlyPublic((v) => !v)}>
                  {onlyPublic ? "Show every item" : "Show only items with a public transaction"}
                </Button>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="muted small">Matrix last updated</span>
                <Badge tone={isStale(file) ? "warning" : undefined}>{file.matrixUpdated ?? "unstated"}</Badge>
              </div>
              <p className="muted small">
                Generated {file.generatedAt ? new Date(file.generatedAt).toLocaleString() : "at an unknown time"}
                {(() => {
                  const age = ageInDays(file);
                  return age !== undefined && age >= 1 ? `, ${age} day${age === 1 ? "" : "s"} ago` : "";
                })()}
                .
              </p>
              {isStale(file) && (
                <div className="banner info">
                  This snapshot is a day or more old and the matrix may have moved under it. Regenerate with
                  node scripts/build-proof.mjs, which the dev and build scripts now do for you.
                </div>
              )}
            </div>
          </Card>

          {file.sections.map((section) => {
            const rows = onlyPublic ? section.rows.filter((r) => r.links.length > 0) : section.rows;
            if (rows.length === 0) return null;
            return (
              <Card key={section.title} title={section.title}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>What it is</th>
                      <th>Status</th>
                      <th>Relay</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={`${row.item}-${i}`}>
                        <td>{row.item}</td>
                        <td>{row.title}</td>
                        <td>
                          <div className="stack" style={{ gap: 4 }}>
                            <Badge tone={TONE[row.state]}>{STATE_LABELS[row.state]}</Badge>
                            <span className="muted small">{row.status}</span>
                          </div>
                        </td>
                        <td className="muted small">{row.relay || "none"}</td>
                        <td>
                          {row.links.length > 0 ? (
                            <ul className="stack" style={{ gap: 2 }}>
                              {row.links.map((l) => (
                                <li key={l.url}>
                                  <a href={l.url} target="_blank" rel="noreferrer">
                                    {l.label}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className="muted small">no public transaction</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
