/** Walks an error's cause chain and returns the most specific human message. */
export function relayReason(err: unknown): string {
  let deepest = "";
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i++) {
    if (typeof e === "string") {
      deepest = e;
      break;
    }
    if (typeof e === "object") {
      const o = e as Record<string, unknown>;
      const details = typeof o.details === "string" ? o.details : undefined;
      const short = typeof o.shortMessage === "string" ? o.shortMessage : undefined;
      const message = typeof o.message === "string" ? o.message : undefined;
      const candidate = details || short || message;
      if (candidate) deepest = candidate;
      e = o.cause;
    } else {
      break;
    }
  }
  return deepest || String(err);
}
