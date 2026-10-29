/**
 * Chrome native messaging framing.
 *
 * Each message on the wire is a 4-byte little-endian length followed by that
 * many bytes of UTF-8 JSON. Chrome writes the length in the machine's native
 * byte order; `packages/contracts/native-messaging.md` pins little-endian,
 * which is what every machine this runs on uses.
 *
 * Kept free of IO on purpose. The failure modes here are the ones that cost
 * hours to diagnose through a pipe (a length prefix split across two reads, two
 * messages delivered in one read, a body that never arrives), and they are only
 * cheap to test if the codec is a function over bytes rather than something
 * wired to a process.
 *
 * Two limits, and they are not the same number:
 *
 *   Outbound, host to extension, is 1 MB. That is Chrome's own ceiling. A frame
 *   over it is dropped by Chrome with no error the host can see, so this module
 *   refuses to encode one and the caller turns that into a visible answer.
 *
 *   Inbound is capped too, far above anything the contract sends. The length
 *   prefix is four attacker-or-bug-controlled bytes that would otherwise ask us
 *   to allocate up to 4 GB before the first byte of the body shows up.
 */

/** Chrome drops anything larger, silently. The contract says stay under it. */
export const MAX_OUTBOUND_BYTES = 1024 * 1024;

/**
 * A ceiling for a length prefix we are willing to believe. The largest thing
 * the contract sends inbound is a SessionHandoff, which is well under a
 * kilobyte, so this is pure headroom against a desynced stream.
 */
export const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

/**
 * The stream cannot be trusted any more: a length prefix we refuse to believe
 * means we no longer know where the next frame starts. Unrecoverable by
 * design, because guessing resynchronisation on a pipe carrying key material
 * is worse than stopping.
 */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

/**
 * One decoded frame. Malformed JSON inside a correctly framed message is a
 * per-message problem, not a stream problem: the length told us where the next
 * frame begins, so the caller answers BAD_REQUEST and carries on. That is why
 * this is a result and not a throw.
 */
export type DecodedFrame =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Encode one message. Throws if it is over Chrome's outbound limit. */
export function encodeFrame(message: unknown): Buffer {
  let json: string;
  try {
    json = JSON.stringify(message);
  } catch (err) {
    throw new FramingError(
      `that message cannot be serialized as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (json === undefined) {
    throw new FramingError("that message serialized to nothing, which cannot be framed.");
  }
  const body = Buffer.from(json, "utf8");
  if (body.byteLength > MAX_OUTBOUND_BYTES) {
    throw new FramingError(
      `that message is ${body.byteLength} bytes, over the ${MAX_OUTBOUND_BYTES} byte limit ` +
        `Chrome puts on a native host message. Chrome drops an oversized frame without ` +
        `telling the host, so it is refused here instead.`,
    );
  }
  const out = Buffer.allocUnsafe(4 + body.byteLength);
  out.writeUInt32LE(body.byteLength, 0);
  body.copy(out, 4);
  return out;
}

/**
 * Accumulates bytes and hands back whole frames.
 *
 * A pipe gives no guarantee about where a read boundary falls, so every method
 * here has to cope with a frame arriving in pieces and with several frames
 * arriving at once.
 */
export class FrameDecoder {
  #buffered: Buffer = Buffer.alloc(0);

  /** Feed bytes in, get every frame they completed out, in order. */
  push(chunk: Buffer | Uint8Array): DecodedFrame[] {
    this.#buffered =
      this.#buffered.byteLength === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#buffered, Buffer.from(chunk)]);

    const frames: DecodedFrame[] = [];
    for (;;) {
      if (this.#buffered.byteLength < 4) break;
      const length = this.#buffered.readUInt32LE(0);
      if (length > MAX_INBOUND_BYTES) {
        throw new FramingError(
          `the next frame claims to be ${length} bytes, over the ${MAX_INBOUND_BYTES} byte ` +
            `limit this host will believe. The stream is out of step, so where the next ` +
            `frame starts is no longer known.`,
        );
      }
      if (this.#buffered.byteLength < 4 + length) break;
      const body = this.#buffered.subarray(4, 4 + length);
      this.#buffered = Buffer.from(this.#buffered.subarray(4 + length));
      frames.push(decodeBody(body));
    }
    return frames;
  }

  /** Bytes held back waiting for the rest of their frame. Diagnostics only. */
  get pending(): number {
    return this.#buffered.byteLength;
  }
}

function decodeBody(body: Buffer): DecodedFrame {
  let text: string;
  try {
    text = body.toString("utf8");
  } catch {
    return { ok: false, error: "that frame is not valid UTF-8." };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    // The text itself is deliberately not quoted back: a malformed frame could
    // hold anything, including a key, and this message reaches a log.
    return {
      ok: false,
      error: `that frame is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
