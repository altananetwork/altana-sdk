export type LogEntry = {
  id: number;
  time: string;
  method: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  level: "info" | "error";
};

let seq = 0;

const SECRET_KEYS = new Set(["signer", "sessionSigner", "privateKey", "sessionKey", "walletKey", "_privateKey"]);

/** Converts values for display: bigints to strings, secrets removed. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function entry(method: string, fields: Partial<Omit<LogEntry, "id" | "time" | "method">>): LogEntry {
  return {
    id: ++seq,
    time: new Date().toISOString().slice(11, 19),
    method,
    level: "info",
    ...fields,
  };
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(redact(value), null, 2);
  } catch {
    return String(value);
  }
}
