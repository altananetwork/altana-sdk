/**
 * `altana-mcp native-host`: the Chrome native messaging end of the extension.
 *
 * Chrome starts this process when the extension calls connectNative, one per
 * open port, and kills it when the port closes. It speaks framed JSON on stdio
 * (see nativeFraming.ts) and answers the requests in
 * `packages/contracts/native-messaging.md`.
 *
 * It never talks to the MCP. They are two modes of one package that share
 * `~/.altana`, so everything this host does is a file the MCP reads on its next
 * call, and everything the MCP does is a file this host notices.
 *
 * Three rules hold this file together:
 *
 *   Stdout carries frames and nothing else. One stray console.log corrupts the
 *   stream, which is why there is a single `say()` for operator output and it
 *   writes to stderr.
 *
 *   Everything that reaches stderr goes through redact(). This process carries
 *   session private keys from the browser to the key store, and a key in a log
 *   fails G8.
 *
 *   Exactly one response per request, with the request's own id. A handler that
 *   throws still produces one, because an extension waiting for an id that
 *   never comes hangs with nothing to show the person.
 */

import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { readAgents, reapDeadAgents, type Agent } from "./agents.js";
import { altanaHome } from "./keys.js";
import { clearLink, writeLink, LinkError } from "./link.js";
import {
  encodeFrame,
  FrameDecoder,
  FramingError,
  type DecodedFrame,
} from "./nativeFraming.js";
import { redact, redactedMessage } from "./redact.js";
import { VERSION } from "./version.js";

/** The protocol version in the contract. Bumped only by a contract change. */
export const PROTOCOL = 0;

/** Error codes the contract allows. No others go on the wire. */
export type ErrorCode =
  | "BAD_REQUEST"
  | "NAME_TAKEN"
  | "NOT_FOUND"
  | "STORE_FAILED"
  | "KEYCHAIN_DENIED"
  | "INTERNAL";

export type HostRequest = { id: string; type: string; payload?: unknown };
export type HostResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: ErrorCode; message: string } };
export type HostEvent = { event: string; payload: unknown };

/**
 * A handler's refusal, with the code that goes on the wire.
 *
 * Anything else that escapes a handler becomes INTERNAL with a redacted
 * message, so an unexpected throw cannot pick its own error code or leak what
 * it was holding.
 */
export class HostError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

/** What a handler is given and what it may send. */
export type HostContext = {
  /** Send an unprompted event to the extension. */
  emit: (event: string, payload: unknown) => void;
  /** Operator output. Goes to stderr, redacted. */
  say: (line: string) => void;
};

export type HostHandler = (payload: unknown, ctx: HostContext) => Promise<unknown>;

/**
 * The milestones that are not built yet.
 *
 * Named here rather than left out of the table, so an extension that calls one
 * early gets a sentence saying which milestone owns it instead of
 * "unknown request type", which would send blockchain looking for a typo on
 * their side. INTERNAL is the closest of the contract's fixed codes: the
 * extension's request was well formed and this end is what is missing. If the
 * PM would rather have a distinct code for it, that is a contracts change.
 */
const NOT_YET: Record<string, string> = {
  sendSession: "M6",
  revokeSession: "M8",
  listRequests: "M7",
  answerRequest: "M7",
};

// ---------- handlers --------------------------------------------------------

function asRecord(payload: unknown, type: string): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new HostError("BAD_REQUEST", `${type} needs its payload to be an object.`);
  }
  return payload as Record<string, unknown>;
}

export const handlers: Record<string, HostHandler> = {
  /**
   * The round trip G1 is about. Deliberately touches no store: if hello works,
   * the manifest, the launcher, the allowed origin and the framing are all
   * right, and a failure after this is about something else.
   */
  hello: async (payload) => {
    const { extensionVersion } = asRecord(payload, "hello");
    return {
      hostVersion: VERSION,
      // One package, so one version. Kept as two fields because the contract
      // has them and because they stop being the same number the day the host
      // ships separately.
      mcpVersion: VERSION,
      altanaHome: altanaHome(),
      protocol: PROTOCOL,
      ...(typeof extensionVersion === "string" ? { sawExtensionVersion: extensionVersion } : {}),
    };
  },

  listAgents: async () => ({ agents: await readAgents() }),

  link: async (payload) => {
    const { address, chainId } = asRecord(payload, "link");
    try {
      await writeLink({ address: String(address ?? ""), chainId: Number(chainId) });
    } catch (err) {
      if (err instanceof LinkError) throw new HostError("BAD_REQUEST", err.message);
      throw new HostError("STORE_FAILED", `link.json could not be written: ${redactedMessage(err)}`);
    }
    return { linked: true };
  },

  unlink: async () => {
    await clearLink();
    return { linked: false };
  },
};

// ---------- the loop --------------------------------------------------------

/**
 * How often the host re-reads the agents directory.
 *
 * A watcher cannot see a process die, and a dead agent still showing as running
 * is what G2 checks for. G2 allows 10 seconds, so 2 is comfortable margin even
 * if a poll is slow. The poll is also the backstop for fs.watch, which on macOS
 * misses writes under load.
 */
export const POLL_MS = 2000;

export type HostStreams = {
  input: AsyncIterable<Buffer | Uint8Array>;
  write: (bytes: Buffer) => void;
  log: (line: string) => void;
};

/**
 * Run the host over a pair of streams.
 *
 * Takes its streams rather than reaching for process.stdin so a test can drive
 * it in-process, which is how every request type below is tested without
 * spawning anything.
 */
export async function runNativeHost(streams: HostStreams): Promise<void> {
  const say = (line: string) => streams.log(redact(line));

  const send = (message: HostResponse | HostEvent) => {
    try {
      streams.write(encodeFrame(message));
    } catch (err) {
      // An oversized or unserializable frame must not take the host down: the
      // port stays open and the next request still gets an answer. The one
      // thing we cannot do is stay silent about it.
      say(`[altana-host] a message could not be sent: ${redactedMessage(err)}`);
    }
  };

  const ctx: HostContext = {
    emit: (event, payload) => send({ event, payload }),
    say,
  };

  const watcher = startAgentWatcher(ctx, say);

  try {
    const decoder = new FrameDecoder();
    for await (const chunk of streams.input) {
      let frames: DecodedFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        // A desynced stream cannot be answered, because the id of whatever was
        // being asked is part of what was lost.
        say(`[altana-host] stopping: ${redactedMessage(err)}`);
        if (err instanceof FramingError) return;
        throw err;
      }
      for (const frame of frames) {
        await handleFrame(frame, send, ctx, say);
      }
    }
  } finally {
    watcher.stop();
  }
}

async function handleFrame(
  frame: DecodedFrame,
  send: (m: HostResponse) => void,
  ctx: HostContext,
  say: (line: string) => void,
): Promise<void> {
  if (!frame.ok) {
    // No id to answer with, so this can only be logged. The extension's own
    // timeout is what surfaces it there.
    say(`[altana-host] ignoring a frame: ${frame.error}`);
    return;
  }
  const request = frame.value as Partial<HostRequest> | null;
  if (!request || typeof request !== "object" || typeof request.id !== "string" || !request.id) {
    say("[altana-host] ignoring a frame with no string id, which leaves nothing to answer.");
    return;
  }
  const id = request.id;
  if (typeof request.type !== "string" || !request.type) {
    send({ id, ok: false, error: { code: "BAD_REQUEST", message: "That request has no type." } });
    return;
  }
  const type = request.type;
  const handler = handlers[type];
  if (!handler) {
    const milestone = NOT_YET[type];
    send({
      id,
      ok: false,
      error: milestone
        ? {
            code: "INTERNAL",
            message:
              `This build of the host does not implement ${type} yet. It lands in ` +
              `milestone ${milestone}. The request itself was well formed.`,
          }
        : { code: "BAD_REQUEST", message: `No request type called ${type}.` },
    });
    return;
  }
  try {
    send({ id, ok: true, result: await handler(request.payload, ctx) });
  } catch (err) {
    if (err instanceof HostError) {
      send({ id, ok: false, error: { code: err.code, message: err.message } });
      return;
    }
    // Everything unplanned lands here, redacted, with one code. A handler that
    // throws while holding a session key must not get to write that key into an
    // error message that goes back over the wire and into a log.
    const message = redactedMessage(err);
    say(`[altana-host] ${type} failed: ${message}`);
    send({ id, ok: false, error: { code: "INTERNAL", message } });
  }
}

/**
 * Watches the agents directory and emits agents.changed when what the extension
 * would see actually changes.
 *
 * Two triggers, because neither is enough on its own: fs.watch for a prompt
 * reaction to a file appearing, and a poll for the things a watcher cannot see,
 * a pid dying above all. Both funnel into one comparison, so the extension
 * never gets an event for a listing it already has.
 */
export function startAgentWatcher(
  ctx: HostContext,
  say: (line: string) => void,
): { stop: () => void } {
  let last = "";
  let closed = false;
  let inFlight = false;

  const check = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const agents = await readAgents();
      const signature = signatureOf(agents);
      if (signature === last) return;
      last = signature;
      ctx.emit("agents.changed", { agents });
      // Only once the extension has been told, so a reap can never remove the
      // evidence for an event that was not sent.
      if (agents.some((a) => !a.running)) await reapDeadAgents();
    } catch (err) {
      say(`[altana-host] the agents directory could not be read: ${redactedMessage(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(check, POLL_MS);
  // The host's whole life is this port, but an interval still should not be the
  // reason the process cannot exit.
  timer.unref?.();

  let fsWatcher: { close: () => void } | undefined;
  void (async () => {
    try {
      const { watch } = await import("node:fs");
      const { mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const dir = join(altanaHome(), "agents");
      // Watching a directory that does not exist throws, and it will not exist
      // until the first agent starts, which is usually after Chrome connects.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (closed) return;
      fsWatcher = watch(dir, () => void check());
    } catch (err) {
      // Not fatal: the poll already covers everything, just 2 seconds later.
      say(`[altana-host] watching the agents directory failed, polling instead: ${redactedMessage(err)}`);
    }
  })();

  // First listing goes out as soon as the port opens, so the extension has
  // something to show without waiting for a change.
  void check();

  return {
    stop: () => {
      closed = true;
      clearInterval(timer);
      fsWatcher?.close();
    },
  };
}

/**
 * What the extension would see, as a string, for change detection.
 *
 * `lastSeen` is left out on purpose. The MCP rewrites it on every tool call, so
 * including it would emit an event per tool call and tell the extension nothing
 * it did not already know. Name, pid and running are what the contract says the
 * extension shows.
 */
function signatureOf(agents: Agent[]): string {
  return agents.map((a) => `${a.client.name}\u0000${a.pid}\u0000${a.running ? 1 : 0}`).join("\u0001");
}

/**
 * Where the host leaves a breadcrumb, so somebody can tell whether Chrome
 * started it at all.
 *
 * Chrome swallows a native host's stderr, which makes "the port is open but
 * nothing answers" impossible to attribute: the host may never have started,
 * may have started and died, or may be answering into a void. One appended line
 * per port settles it, and settling it is the difference between looking at the
 * extension and looking at the host.
 *
 * Everything written here has already been through redact().
 */
export function hostLogPath(): string {
  return join(altanaHome(), "host.log");
}

/** Keep the breadcrumb file from growing without bound. */
const HOST_LOG_MAX_BYTES = 64 * 1024;

async function appendToHostLog(line: string): Promise<void> {
  try {
    const path = hostLogPath();
    await mkdir(altanaHome(), { recursive: true, mode: 0o700 });
    // Truncating beats rotating here: this is a breadcrumb trail for the last
    // few runs, not a record anybody needs to keep.
    const size = await stat(path).then((s) => s.size, () => 0);
    if (size > HOST_LOG_MAX_BYTES) await writeFile(path, "", { mode: 0o600 });
    await appendFile(path, line, { mode: 0o600 });
  } catch {
    // A host that cannot write its own diagnostics still has a job to do.
  }
}

/** Wire the host to this process's stdio. The `native-host` entry point. */
export async function runNativeHostOnStdio(): Promise<void> {
  const stamp = () => new Date().toISOString();

  // Chrome appends the calling origin, and on some platforms a window handle,
  // after the arguments the launcher already passed. Recorded because a wrong
  // origin here is one of the few ways this fails silently.
  const chromeArgs = process.argv.slice(3);
  void appendToHostLog(
    `${stamp()} start pid=${process.pid} altanaHome=${altanaHome()} ` +
      `args=${JSON.stringify(chromeArgs)}\n`,
  );

  const log = (line: string) => {
    process.stderr.write(`${line}\n`);
    void appendToHostLog(`${stamp()} ${line}\n`);
  };

  try {
    await runNativeHost({
      input: process.stdin,
      // writeSync on fd 1, not process.stdout.write. Chrome keeps the port's
      // stdin open for the life of the connection, so nothing ever flushes a
      // buffered stream on exit, and a frame still sitting in a buffer is a
      // request the extension waits on forever. A partial write is possible on
      // a pipe, so this loops until the frame is out.
      write: (bytes) => {
        let written = 0;
        while (written < bytes.byteLength) {
          written += writeSync(1, bytes, written, bytes.byteLength - written);
        }
      },
      log,
    });
    void appendToHostLog(`${stamp()} end pid=${process.pid} the port closed\n`);
  } catch (err) {
    // Chrome shows a host that died as a disconnect with no reason, so the
    // reason has to be written down somewhere before this process goes.
    await appendToHostLog(`${stamp()} died pid=${process.pid} ${redactedMessage(err)}\n`);
    throw err;
  }
}
