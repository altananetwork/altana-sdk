import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  FramingError,
  MAX_INBOUND_BYTES,
  MAX_OUTBOUND_BYTES,
} from "./nativeFraming.js";

/** The length prefix, read the way Chrome writes it. */
function lengthOf(frame: Buffer): number {
  return frame.readUInt32LE(0);
}

describe("encodeFrame", () => {
  test("puts a little-endian length in front of the JSON", () => {
    const frame = encodeFrame({ id: "a", type: "hello" });
    const body = JSON.stringify({ id: "a", type: "hello" });
    expect(lengthOf(frame)).toBe(Buffer.byteLength(body, "utf8"));
    expect(frame.subarray(4).toString("utf8")).toBe(body);
  });

  test("counts bytes, not characters, so a multibyte payload is not truncated", () => {
    // A length in characters would be short here, and the reader would stop
    // mid-character and desync the stream.
    const frame = encodeFrame({ note: "ünïcödé" });
    expect(lengthOf(frame)).toBe(frame.byteLength - 4);
    expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual({ note: "ünïcödé" });
  });

  test("refuses a frame over Chrome's 1 MB limit instead of letting Chrome drop it", () => {
    const tooBig = { pad: "x".repeat(MAX_OUTBOUND_BYTES) };
    expect(() => encodeFrame(tooBig)).toThrow(FramingError);
    expect(() => encodeFrame(tooBig)).toThrow(/1048576 byte limit/);
  });

  test("allows a frame just under the limit", () => {
    const body = JSON.stringify({ pad: "x".repeat(MAX_OUTBOUND_BYTES - 100) });
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_OUTBOUND_BYTES);
    expect(() => encodeFrame(JSON.parse(body))).not.toThrow();
  });

  test("says so when a message cannot be JSON at all", () => {
    expect(() => encodeFrame({ big: 1n })).toThrow(FramingError);
  });
});

describe("FrameDecoder", () => {
  test("reads one whole frame", () => {
    const d = new FrameDecoder();
    const frames = d.push(encodeFrame({ id: "1", type: "hello" }));
    expect(frames).toEqual([{ ok: true, value: { id: "1", type: "hello" } }]);
    expect(d.pending).toBe(0);
  });

  test("reads two frames delivered in one chunk", () => {
    // A pipe gives no guarantee of one write per read, and an extension that
    // sends two requests quickly lands here.
    const d = new FrameDecoder();
    const frames = d.push(
      Buffer.concat([encodeFrame({ id: "1", type: "hello" }), encodeFrame({ id: "2", type: "listAgents" })]),
    );
    expect(frames.map((f) => (f.ok ? (f.value as { id: string }).id : "bad"))).toEqual(["1", "2"]);
  });

  test("waits when the length prefix itself is split across chunks", () => {
    const whole = encodeFrame({ id: "1", type: "hello" });
    const d = new FrameDecoder();
    expect(d.push(whole.subarray(0, 2))).toEqual([]);
    expect(d.push(whole.subarray(2, 3))).toEqual([]);
    const frames = d.push(whole.subarray(3));
    expect(frames).toEqual([{ ok: true, value: { id: "1", type: "hello" } }]);
  });

  test("waits when the body arrives a byte at a time", () => {
    const whole = encodeFrame({ id: "drip", type: "hello" });
    const d = new FrameDecoder();
    const out = [];
    for (const byte of whole) out.push(...d.push(Buffer.from([byte])));
    expect(out).toEqual([{ ok: true, value: { id: "drip", type: "hello" } }]);
  });

  test("holds a truncated frame rather than guessing at it", () => {
    const whole = encodeFrame({ id: "1", type: "hello" });
    const d = new FrameDecoder();
    expect(d.push(whole.subarray(0, whole.byteLength - 1))).toEqual([]);
    expect(d.pending).toBe(whole.byteLength - 1);
  });

  test("reports bad JSON per frame and keeps reading the next one", () => {
    // The length told us where this frame ended, so the stream is still in
    // step: one request is refused, the connection survives.
    const bad = Buffer.alloc(4 + 5);
    bad.writeUInt32LE(5, 0);
    bad.write("{not!", 4, "utf8");
    const d = new FrameDecoder();
    const frames = d.push(Buffer.concat([bad, encodeFrame({ id: "2", type: "hello" })]));
    expect(frames[0]?.ok).toBe(false);
    expect(frames[1]).toEqual({ ok: true, value: { id: "2", type: "hello" } });
  });

  test("throws on a length prefix it will not believe", () => {
    const d = new FrameDecoder();
    const absurd = Buffer.alloc(4);
    absurd.writeUInt32LE(MAX_INBOUND_BYTES + 1, 0);
    expect(() => d.push(absurd)).toThrow(FramingError);
  });

  test("an empty chunk changes nothing", () => {
    const d = new FrameDecoder();
    expect(d.push(Buffer.alloc(0))).toEqual([]);
    expect(d.pending).toBe(0);
  });
});
