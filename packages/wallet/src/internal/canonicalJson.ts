/**
 * Canonical JSON — the cross-ecosystem hashing form.
 *
 * Keys sorted at every depth, compact separators, no incidental whitespace,
 * every non-ASCII character escaped as `\uXXXX` (per UTF-16 code unit, so
 * astral characters become surrogate-pair escapes).
 *
 * Byte-identical to `@bnbagent/sdk`'s `canonicalJson` and to Python's
 * `json.dumps(x, sort_keys=True, separators=(",", ":"))` (whose default
 * `ensure_ascii=True` produces the same escaping). ERC-8004 registration
 * records and ERC-8183 deliverable manifests are hashed over this form, so
 * a document written by this SDK hashes the same as one written by the
 * Python reference. Do not "simplify" this to a plain JSON.stringify — the
 * escaping is what keeps JS- and Python-produced hashes equal for any
 * content containing an em-dash, an accent, CJK, or an emoji.
 *
 * The output is pure ASCII by construction, which is also what lets
 * callers `btoa` it directly (browser-safe latin1).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    throw new Error(`canonicalJson: documents cannot contain non-finite numbers (got ${v}).`);
  }
  return v;
}
