/**
 * One place that strips key material out of text on its way to a log.
 *
 * `docs/rules.md` says a private key must never be printed, logged or
 * committed, and the native host's whole job is carrying one from a browser to
 * a key store. Depending on every future `console.error` to remember that is
 * how a key ends up in a log file, so every line the host writes goes through
 * here first, including the ones inside error messages written by code that has
 * no idea it is holding a key.
 *
 * The pattern is deliberately broad: any run of 64 hex characters, with or
 * without an 0x prefix. A secp256k1 private key is exactly that, and so is a
 * key hash or a transaction hash, which get redacted too. Losing a tx hash from
 * a log line is a small cost; the alternative is a rule that tries to tell a
 * secret 32-byte hex string from a public one, which cannot be done from the
 * text alone.
 */

const HEX_64 = /(0x)?[0-9a-fA-F]{64}/g;

export const REDACTED = "[redacted 32 byte hex]";

/** Replace every 32-byte hex run in a string. */
export function redact(text: string): string {
  return text.replace(HEX_64, REDACTED);
}

/**
 * Redact anything, for the cases where what reaches a log is an object or a
 * thrown value rather than a string. Walks plain objects and arrays so a key
 * nested in a payload is caught as well, and never calls a getter twice.
 */
export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactUnknown(v);
  }
  return out;
}

/** The message of a thrown value, redacted, for an operator-facing line. */
export function redactedMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
