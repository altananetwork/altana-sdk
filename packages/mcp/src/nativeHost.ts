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

import { appendFileSync, mkdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
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
import { markRevoked } from "./revoked.js";
import { deleteSession, getSession } from "./sessions.js";
import { deleteSessionKey } from "./keys.js";
import {
  answerRequest as recordAnswer,
  listPendingRequests,
  readRequest,
  requestsDir,
  RequestError,
  type PermissionRequest,
} from "./requests.js";
import {
  parseHandoff,
  sessionFromHandoff,
  storeHandedOverSession,
  SessionHandoverError,
  SessionNameTakenError,
} from "./storeSession.js";
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
const NOT_YET: Record<string, string> = {};

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

  /**
   * A permission the extension granted on chain, handed over so the agent can
   * use it.
   *
   * The payload carries a private key, which makes this the one handler where
   * every line has to assume that anything it touches could end up in a log.
   * Nothing here echoes the payload, the error paths say what is wrong without
   * saying what the value was, and the result carries only what is safe to
   * show.
   *
   * It writes through the same function `import_session` uses, so the contract's
   * promise holds: the MCP's next `list_sessions` and `session_execute` see this
   * session, with no restart and no difference from one pasted in by hand.
   */
  sendSession: async (payload, ctx) => storeFromHandoff(payload, ctx),

  /** Pending only, as the contract says. An expired request is not pending. */
  listRequests: async () => ({ requests: await listPendingRequests() }),

  /**
   * Take a permission away.
   *
   * The on-chain revoke is the extension's: it holds the wallet's admin key and
   * this machine never will. By the time this arrives the key is already dead
   * on chain, and all that is left is removing the local copy so the agent
   * stops trying to sign with authority it no longer has.
   *
   * The marker is written before the session is deleted, so there is no window
   * where the session is gone and nothing can say why. The reverse order would
   * put that window exactly where a crash is most likely to land, between two
   * writes.
   */
  revokeSession: async (payload, ctx) => {
    const { name } = asRecord(payload, "revokeSession");
    if (typeof name !== "string" || !name.trim()) {
      throw new HostError("BAD_REQUEST", "revokeSession needs the name of the permission to remove.");
    }
    const sessionName = name.trim();

    let existed = true;
    try {
      await getSession(sessionName);
    } catch {
      // Already gone. Still worth a marker and an event: the extension may be
      // reconciling after a crash, and the agent should still get the better
      // answer on its next attempt.
      existed = false;
    }

    try {
      await markRevoked({ name: sessionName, by: "extension" });
      await deleteSessionKey(sessionName);
      await deleteSession(sessionName);
    } catch (err) {
      throw new HostError(
        "STORE_FAILED",
        `The permission "${sessionName}" could not be removed locally: ${redactedMessage(err)}`,
      );
    }

    ctx.say(`[altana-host] removed the permission "${sessionName}"`);
    ctx.emit("session.revoked", { name: sessionName });
    return { removed: existed };
  },

  /**
   * The person's answer to a request the agent made.
   *
   * On approve the session is stored first and the request is marked approved
   * only afterwards. That order is the whole design of this handler: a crash
   * between the two leaves a request still pending, which somebody can approve
   * again, rather than an approval with no permission behind it, which would
   * leave the agent told yes by a request whose session does not exist.
   */
  answerRequest: async (payload, ctx) => {
    const { id, decision, session } = asRecord(payload, "answerRequest");
    if (typeof id !== "string" || !id) {
      throw new HostError("BAD_REQUEST", "answerRequest needs the id of the request to answer.");
    }
    if (decision !== "approve" && decision !== "reject") {
      throw new HostError("BAD_REQUEST", 'answerRequest needs decision to be "approve" or "reject".');
    }

    const existing = await readRequest(id);
    if (!existing) {
      throw new HostError("NOT_FOUND", `There is no permission request with id ${id}.`);
    }
    if (existing.status !== "pending") {
      // Also how two hosts racing on one file settle it: whoever is second is
      // told it is not theirs to answer rather than overwriting an answer that
      // has already been acted on.
      throw new HostError(
        "NOT_FOUND",
        `That permission request was already ${existing.status}, so there is nothing left to answer.`,
      );
    }

    if (decision === "reject") {
      await markAnswered({ id, decision: "reject" });
      ctx.emit("request.answered", { id, status: "rejected" });
      return { answered: true };
    }

    if (session === undefined) {
      throw new HostError(
        "BAD_REQUEST",
        "An approval has to carry the session it granted, in the same shape as sendSession.",
      );
    }
    const stored = await storeFromHandoff(session, ctx);
    await markAnswered({ id, decision: "approve", sessionName: stored.name });
    ctx.emit("request.answered", { id, status: "approved", name: stored.name });
    return { answered: true };
  },
};

/** Map a request store failure onto the contract's codes. */
async function markAnswered(args: {
  id: string;
  decision: "approve" | "reject";
  sessionName?: string;
}): Promise<void> {
  try {
    await recordAnswer(args);
  } catch (err) {
    if (err instanceof RequestError) throw new HostError("NOT_FOUND", err.message);
    throw new HostError("STORE_FAILED", `The answer could not be written: ${redactedMessage(err)}`);
  }
}

/**
 * Store a handed over permission.
 *
 * Shared by `sendSession` and the approve path of `answerRequest` on purpose:
 * approving a request has to leave exactly the state that sending a permission
 * does, or a permission that arrived by one route would work and the other
 * would not.
 */
async function storeFromHandoff(
  payload: unknown,
  ctx: HostContext,
): Promise<{ stored: true; name: string; walletAddress: string; sessionAddress: string; keyHash: string; expiresAt: string; expired: boolean }> {
  let name = "(unnamed)";
  try {
    const handoff = parseHandoff(payload);
    name = handoff.name;
    const session = sessionFromHandoff(handoff);
    const stored = await storeHandedOverSession({
      sessionName: handoff.name,
      session,
      privateKey: handoff.sessionPrivateKey,
    });
    // Named, never with any part of the key. Somebody watching the host's
    // output should be able to see that a permission arrived.
    ctx.say(`[altana-host] stored the permission "${stored.sessionName}" for ${stored.walletAddress}`);
    return {
      stored: true,
      name: stored.sessionName,
      walletAddress: stored.walletAddress,
      sessionAddress: stored.sessionAddress,
      keyHash: stored.keyHash,
      expiresAt: stored.expiresAt,
      expired: stored.expired,
    };
    } catch (err) {
    if (err instanceof SessionNameTakenError) {
      throw new HostError("NAME_TAKEN", err.message);
    }
    if (err instanceof SessionHandoverError) {
      throw new HostError("BAD_REQUEST", err.message);
    }
    // Anything else got as far as the key store or the sessions file. The
    // keychain is worth separating because a refusal there is somebody
    // clicking Deny on a dialog, which is not a bug to go looking for.
    const message = redactedMessage(err);
    if (/keychain|denied|security|authoriz/i.test(message)) {
      throw new HostError(
        "KEYCHAIN_DENIED",
        `The permission "${name}" could not be saved because the keychain refused: ${message}`,
      );
    }
    throw new HostError(
      "STORE_FAILED",
      `The permission "${name}" could not be saved: ${message}`,
    );
  }
}

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

  // Both directories the contract says the host watches while its port is open.
  const watchers = [startAgentWatcher(ctx, say), startRequestWatcher(ctx, say)];

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
    for (const watcher of watchers) watcher.stop();
  }
}

async function handleFrame(
  frame: DecodedFrame,
  send: (m: HostResponse) => void,
  ctx: HostContext,
  say: (line: string) => void,
): Promise<void> {
  /**
   * Every refusal leaves through here, redacted.
   *
   * A handler's message is not necessarily a string this file wrote. A
   * handover failure carries the SDK's own error text, and the SDK is under no
   * obligation to keep key material out of it. Redacting at the one point
   * everything leaves by is the only version of this that stays true as
   * handlers are added.
   */
  const fail = (id: string, code: ErrorCode, message: string) =>
    send({ id, ok: false, error: { code, message: redact(message) } });
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
    fail(id, "BAD_REQUEST", "That request has no type.");
    return;
  }
  const type = request.type;
  const handler = handlers[type];
  if (!handler) {
    const milestone = NOT_YET[type];
    if (milestone) {
      fail(
        id,
        "INTERNAL",
        `This build of the host does not implement ${type} yet. It lands in ` +
          `milestone ${milestone}. The request itself was well formed.`,
      );
    } else {
      fail(id, "BAD_REQUEST", `No request type called ${type}.`);
    }
    return;
  }
  try {
    send({ id, ok: true, result: await handler(request.payload, ctx) });
  } catch (err) {
    if (err instanceof HostError) {
      fail(id, err.code, err.message);
      return;
    }
    // Everything unplanned lands here, redacted, with one code. A handler that
    // throws while holding a session key must not get to write that key into an
    // error message that goes back over the wire and into a log.
    const message = redactedMessage(err);
    say(`[altana-host] ${type} failed: ${message}`);
    fail(id, "INTERNAL", message);
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
/**
 * Watch one directory under ALTANA_HOME, with a poll behind the watcher.
 *
 * Shared by both watchers rather than written twice. The mechanics are the
 * fiddly part, and they are identical: create the directory first because
 * watching one that does not exist throws and neither directory exists until
 * something writes to it, never run two checks at once, survive a watcher that
 * cannot be set up, and leave nothing behind that stops the process exiting.
 * Only what to do on a change differs.
 */
function startDirectoryWatcher(args: {
  dir: string;
  label: string;
  check: () => Promise<void>;
  say: (line: string) => void;
}): { stop: () => void } {
  let closed = false;
  let inFlight = false;

  const run = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      await args.check();
    } catch (err) {
      args.say(
        `[altana-host] the ${args.label} directory could not be read: ${redactedMessage(err)}`,
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(run, POLL_MS);
  // The host's whole life is this port, but an interval still should not be the
  // reason the process cannot exit.
  timer.unref?.();

  let fsWatcher: { close: () => void } | undefined;
  void (async () => {
    try {
      const { watch } = await import("node:fs");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(args.dir, { recursive: true, mode: 0o700 });
      if (closed) return;
      fsWatcher = watch(args.dir, () => void run());
    } catch (err) {
      // Not fatal: the poll already covers everything, just a beat later.
      args.say(
        `[altana-host] watching the ${args.label} directory failed, polling instead: ${redactedMessage(err)}`,
      );
    }
  })();

  // First pass as soon as the port opens, so the extension has something to
  // show without waiting for a change.
  void run();

  return {
    stop: () => {
      closed = true;
      clearInterval(timer);
      fsWatcher?.close();
    },
  };
}

export function startAgentWatcher(
  ctx: HostContext,
  say: (line: string) => void,
): { stop: () => void } {
  let last = "";
  return startDirectoryWatcher({
    dir: join(altanaHome(), "agents"),
    label: "agents",
    say,
    check: async () => {
      const agents = await readAgents();
      const signature = signatureOf(agents);
      if (signature === last) return;
      last = signature;
      ctx.emit("agents.changed", { agents });
      // Only once the extension has been told, so a reap can never remove the
      // evidence for an event that was not sent.
      if (agents.some((a) => !a.running)) await reapDeadAgents();
    },
  });
}

/**
 * Watches the requests directory and announces a new one.
 *
 * The contract has the host doing this, and it is what lets the extension show
 * a badge the moment an agent asks rather than only when something happens to
 * poll. G5 is "the agent asks, the extension shows it": without this the
 * showing depends on the extension polling, which is slower and is not what the
 * contract says either side should rely on.
 *
 * Announced once per id. Ids are uuids, so an id that has been seen is never a
 * different request later, and the set is pruned to what is still pending so a
 * long lived port does not accumulate every id it ever saw.
 */
export function startRequestWatcher(
  ctx: HostContext,
  say: (line: string) => void,
): { stop: () => void } {
  const announced = new Set<string>();
  let first = true;
  return startDirectoryWatcher({
    dir: requestsDir(),
    label: "requests",
    say,
    check: async () => {
      const pending = await listPendingRequests();
      const ids = new Set(pending.map((r) => r.id));

      for (const request of pending) {
        if (announced.has(request.id)) continue;
        announced.add(request.id);
        // A request already waiting when the port opens is new to this
        // extension window, which is the case that matters after a Chrome
        // restart: the agent is still waiting and nothing else would say so.
        ctx.emit("request.created", { request });
      }
      if (first) {
        first = false;
        if (pending.length > 0) {
          say(`[altana-host] ${pending.length} permission request(s) were already waiting`);
        }
      }

      // Answered, expired or deleted requests drop out of the set, so it stays
      // the size of what is actually outstanding.
      for (const id of announced) {
        if (!ids.has(id)) announced.delete(id);
      }
    },
  });
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
 * How long the frame write will wait for a pipe that will not take bytes.
 *
 * There used to be no limit here, which was indefensible: an fd that never
 * drains meant a process that never ended, and QA found hosts from the previous
 * day still alive nineteen hours after the Chrome that started them had gone.
 * Giving up and saying so beats hanging, because a hang is the one failure that
 * leaves nothing to read.
 */
const WRITE_DEADLINE_MS = 5000;

/** Sleep without burning a core, and without handing control to the event loop. */
function sleepSync(ms: number): void {
  // Atomics.wait on a buffer nobody will notify is a real sleep. A busy spin
  // would compete with the very read that has to make progress for the pipe to
  // drain.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* no Atomics here, so spin */
    }
  }
}

/**
 * Write one frame to fd 1, and say what happened.
 *
 * Instrumented because this is the half of the g1 failure there was no evidence
 * about: the host logged the frame arriving and then nothing at all, and a
 * write that neither returned nor threw would look exactly like that.
 */
function writeFrameToStdout(bytes: Buffer): void {
  const deadline = Date.now() + WRITE_DEADLINE_MS;
  let written = 0;
  let retries = 0;

  appendToHostLog(
    `${new Date().toISOString()} write start pid=${process.pid} bytes=${bytes.byteLength}\n`,
  );

  while (written < bytes.byteLength) {
    try {
      written += writeSync(1, bytes, written, bytes.byteLength - written);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
      if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EINTR") {
        retries += 1;
        if (Date.now() > deadline) {
          appendToHostLog(
            `${new Date().toISOString()} write gave up pid=${process.pid} ` +
              `code=${code} written=${written}/${bytes.byteLength} retries=${retries}\n`,
          );
          throw new Error(
            `stdout would not accept the frame within ${WRITE_DEADLINE_MS}ms ` +
              `(${code} after ${retries} retries, ${written} of ${bytes.byteLength} bytes written)`,
          );
        }
        // Logged sparsely: enough to see it happening, not enough to fill the file.
        if (retries === 1 || retries % 100 === 0) {
          appendToHostLog(
            `${new Date().toISOString()} write retry pid=${process.pid} ` +
              `code=${code} n=${retries} written=${written}/${bytes.byteLength}\n`,
          );
        }
        if (code !== "EINTR") sleepSync(1);
        continue;
      }
      appendToHostLog(
        `${new Date().toISOString()} write failed pid=${process.pid} ` +
          `code=${code} written=${written}/${bytes.byteLength}\n`,
      );
      throw err;
    }
  }

  appendToHostLog(
    `${new Date().toISOString()} write done pid=${process.pid} bytes=${written}` +
      `${retries > 0 ? ` retries=${retries}` : ""}\n`,
  );
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

/**
 * Append a breadcrumb synchronously.
 *
 * Synchronous because of how this file is read. The lines that matter most are
 * the last ones before the process goes, and an async append that has been
 * handed to the event loop is simply lost if the process exits first. QA's
 * first host.log had a start line and nothing else, which is exactly what a
 * lost end line looks like, so the difference between "it is still running"
 * and "it exited and we did not catch it" was unreadable.
 */
function appendToHostLog(line: string): void {
  try {
    const path = hostLogPath();
    mkdirSync(altanaHome(), { recursive: true, mode: 0o700 });
    // Truncating beats rotating here: this is a breadcrumb trail for the last
    // few runs, not a record anybody needs to keep.
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size > HOST_LOG_MAX_BYTES) writeFileSync(path, "", { mode: 0o600 });
    appendFileSync(path, line, { mode: 0o600 });
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
  appendToHostLog(
    `${stamp()} start pid=${process.pid} altanaHome=${altanaHome()} ` +
      `runtime=${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`} ` +
      `args=${JSON.stringify(chromeArgs)}\n`,
  );

  const log = (line: string) => {
    process.stderr.write(`${line}\n`);
    appendToHostLog(`${stamp()} ${line}\n`);
  };

  // A host that dies without saying why is the hardest thing to chase here,
  // because Chrome reports it as a disconnect with no reason and swallows
  // stderr. These three are the only way the last moment gets written down.
  process.on("uncaughtException", (err) => {
    appendToHostLog(`${stamp()} uncaught pid=${process.pid} ${redactedMessage(err)}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    appendToHostLog(`${stamp()} unhandled pid=${process.pid} ${redactedMessage(reason)}\n`);
    process.exit(1);
  });
  process.on("exit", (code) => {
    appendToHostLog(`${stamp()} exit pid=${process.pid} code=${code}\n`);
  });

  // A port Chrome has forgotten about is the other way a host outlives its
  // browser: stdin never closes, so nothing ends. If no byte has ever arrived
  // after this long, there is nothing on the other end worth waiting for.
  const SILENT_PORT_LIMIT_MS = 10 * 60 * 1000;
  let sawAnyBytes = false;
  const idleGuard = setTimeout(() => {
    if (sawAnyBytes) return;
    appendToHostLog(
      `${stamp()} giving up pid=${process.pid} nothing arrived in ${SILENT_PORT_LIMIT_MS}ms\n`,
    );
    process.exit(0);
  }, SILENT_PORT_LIMIT_MS);
  idleGuard.unref?.();

  try {
    appendToHostLog(`${stamp()} reading stdin pid=${process.pid}\n`);
    await runNativeHost({
      input: (async function* () {
        for await (const chunk of stdinFrames()) {
          sawAnyBytes = true;
          yield chunk;
        }
      })(),
      // writeSync on fd 1, not process.stdout.write. Chrome keeps the port's
      // stdin open for the life of the connection, so nothing ever flushes a
      // buffered stream on exit, and a frame still sitting in a buffer is a
      // request the extension waits on forever.
      //
      // Two things a pipe does that a naive write would get wrong. It can
      // accept only part of a frame, so this loops until the frame is out. And
      // if the fd happens to be non-blocking it can refuse with EAGAIN when its
      // buffer is full, which is not an error but a "not yet"; letting that
      // escape would kill the host over a full pipe, dropping the port and
      // every pending request with it.
      write: (bytes) => writeFrameToStdout(bytes),
      log,
    });
    appendToHostLog(`${stamp()} end pid=${process.pid} stdin ended, so the port closed\n`);
    // Exiting explicitly, rather than trusting the event loop to empty.
    //
    // QA found hosts from the previous day still alive nineteen hours after the
    // Chrome that started them had gone. A host whose port has closed has
    // nothing left to do, and anything still referenced (a watcher, a half open
    // descriptor, a pending read) keeps the process alive for no reason while
    // holding a key store open.
    process.exit(0);
  } catch (err) {
    // Chrome shows a host that died as a disconnect with no reason, so the
    // reason has to be written down somewhere before this process goes.
    appendToHostLog(`${stamp()} died pid=${process.pid} ${redactedMessage(err)}\n`);
    // Same reasoning as the clean path, and more pressing: whatever went wrong
    // may be the thing holding the loop open.
    process.exit(1);
  }
}

/**
 * Read framed bytes from fd 0, rather than from `process.stdin`.
 *
 * Chrome hands a native host the connection as a file descriptor, and on macOS
 * it is not always the kind of pipe `process.stdin` expects: a stream built for
 * a pipe can report end of file immediately on a socket, which looks exactly
 * like Chrome closing the port the instant it opened it. Reading fd 0 through
 * a descriptor the runtime did not pre-wrap avoids guessing which it is, and it
 * is the same reasoning as writing frames with writeSync on fd 1.
 *
 * Each chunk is logged by size only, never by content: the bytes here are the
 * ones that carry a session key.
 */
async function* stdinFrames(): AsyncGenerator<Buffer> {
  const stream = createReadStream("", { fd: 0, autoClose: false });
  let chunks = 0;
  let total = 0;
  try {
    for await (const chunk of stream) {
      chunks += 1;
      const bytes = Buffer.from(chunk as Buffer);
      total += bytes.byteLength;
      // Every chunk, not just the first. Chrome splits a frame across reads,
      // and a log that only recorded the first one could not tell a frame that
      // never finished arriving from one that arrived and was never answered.
      appendToHostLog(
        `${new Date().toISOString()} chunk ${chunks} pid=${process.pid} ` +
          `bytes=${bytes.byteLength} total=${total}\n`,
      );
      yield bytes;
    }
  } catch (err) {
    appendToHostLog(
      `${new Date().toISOString()} stdin failed pid=${process.pid} ` +
        `chunks=${chunks} ${redactedMessage(err)}\n`,
    );
    throw err;
  } finally {
    appendToHostLog(
      `${new Date().toISOString()} stdin closed pid=${process.pid} chunks=${chunks} total=${total}\n`,
    );
  }
}
