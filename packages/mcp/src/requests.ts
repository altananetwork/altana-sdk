/**
 * `~/.altana/requests/<id>.json`: an agent asking for a permission it does not
 * have.
 *
 * The direction that makes this different from everything else in the contract:
 * the agent starts it. The MCP writes a request and then waits, the host sees
 * the file and tells the extension, the person approves or rejects, the host
 * writes the answer, and the MCP's wait ends. Two processes, one directory, no
 * connection between them.
 *
 * Waiting is the hard part, and it is why the state machine is this explicit. An
 * agent sitting in `request_permission` is a conversation stopped mid sentence,
 * so every path has to end: approved, rejected, expired, or a refusal the agent
 * can explain. A request that could hang forever would be worse than one that
 * is refused.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { altanaHome } from "./keys.js";

export function requestsDir(): string {
  return join(altanaHome(), "requests");
}

function requestPath(id: string): string {
  return join(requestsDir(), `${id}.json`);
}

export type RequestStatus = "pending" | "approved" | "rejected" | "expired";

/** What the agent is asking for. Mirrors the contract field for field. */
export type PermissionAsk = {
  name: string;
  chainId: number;
  spend?: { limit: string; period: string; token?: string }[];
  /** Omitted means any contract. An empty array means none, as everywhere else. */
  calls?: { to?: string; signature?: string }[];
  expirySeconds: number;
  reason: string;
};

export type PermissionRequest = {
  v: 1;
  id: string;
  client: { name: string; version?: string };
  createdAt: string;
  expiresAt: string;
  status: RequestStatus;
  ask: PermissionAsk;
  answer: { sessionName: string } | null;
};

export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** How long a request waits before it gives up, unless the caller says otherwise. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/** How often the MCP looks at its own request file while waiting. */
export const POLL_MS = 500;

async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(requestsDir(), { recursive: true, mode: 0o700 });
  // The host watches this directory, so a reader must never catch a partly
  // written file: it would parse as broken JSON for a request that is fine.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
}

/** Write a new pending request. */
export async function createRequest(args: {
  id: string;
  client: { name: string; version?: string };
  ask: PermissionAsk;
  timeoutSeconds?: number;
}): Promise<PermissionRequest> {
  const now = Date.now();
  const timeout = args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const request: PermissionRequest = {
    v: 1,
    id: args.id,
    client: args.client,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeout * 1000).toISOString(),
    status: "pending",
    ask: args.ask,
    answer: null,
  };
  await writeAtomic(requestPath(args.id), JSON.stringify(request, null, 2));
  return request;
}

export async function readRequest(id: string): Promise<PermissionRequest | undefined> {
  return parseRequest(await readFile(requestPath(id), "utf8").catch(() => undefined));
}

function parseRequest(raw: string | undefined): PermissionRequest | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PermissionRequest>;
    if (typeof parsed.id !== "string" || typeof parsed.status !== "string") return undefined;
    if (!parsed.ask || typeof parsed.ask !== "object") return undefined;
    return parsed as PermissionRequest;
  } catch {
    return undefined;
  }
}

/** Has that request run out of time? Decided from the file, not from a timer. */
export function hasExpired(request: PermissionRequest, now = Date.now()): boolean {
  const at = Date.parse(request.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * Every request still waiting for an answer.
 *
 * The contract says `listRequests` returns pending only, and a request past its
 * expiry is not pending even if its file still says so: the file is written once
 * and time keeps moving, so the status on disk is a claim that has to be checked
 * against the clock. Anything else would show the person a request to approve
 * that the agent has already given up on.
 */
export async function listPendingRequests(now = Date.now()): Promise<PermissionRequest[]> {
  let names: string[];
  try {
    names = await readdir(requestsDir());
  } catch {
    return [];
  }
  const pending: PermissionRequest[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const request = parseRequest(await readFile(join(requestsDir(), name), "utf8").catch(() => undefined));
    if (!request || request.status !== "pending") continue;
    if (hasExpired(request, now)) continue;
    pending.push(request);
  }
  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return pending;
}

/**
 * Record an answer, but only on a request that is still pending.
 *
 * The pending check is what settles two hosts racing on the same file, and the
 * more likely case of somebody approving in one window while the request has
 * already expired. Whoever writes second is told the request is no longer theirs
 * to answer rather than overwriting an answer that has already been acted on.
 */
export async function answerRequest(args: {
  id: string;
  decision: "approve" | "reject";
  sessionName?: string;
  now?: number;
}): Promise<PermissionRequest> {
  const existing = await readRequest(args.id);
  if (!existing) {
    throw new RequestError(`There is no permission request with id ${args.id}.`);
  }
  if (existing.status !== "pending") {
    throw new RequestError(
      `That permission request was already ${existing.status}, so there is nothing left to answer.`,
    );
  }
  if (hasExpired(existing, args.now ?? Date.now())) {
    // Written down rather than just refused, so the agent's own wait ends with
    // the same word the person saw.
    const expired: PermissionRequest = { ...existing, status: "expired" };
    await writeAtomic(requestPath(args.id), JSON.stringify(expired, null, 2));
    throw new RequestError(
      "That permission request expired before it was answered. The agent has stopped " +
        "waiting for it, so ask it to request the permission again.",
    );
  }
  if (args.decision === "approve" && !args.sessionName) {
    throw new RequestError("An approval has to say which session name was stored.");
  }

  const answered: PermissionRequest = {
    ...existing,
    status: args.decision === "approve" ? "approved" : "rejected",
    answer: args.decision === "approve" ? { sessionName: args.sessionName! } : null,
  };
  await writeAtomic(requestPath(args.id), JSON.stringify(answered, null, 2));
  return answered;
}

/** Mark a request expired. Used by the waiter when its own time runs out. */
export async function expireRequest(id: string): Promise<void> {
  const existing = await readRequest(id);
  if (!existing || existing.status !== "pending") return;
  await writeAtomic(requestPath(id), JSON.stringify({ ...existing, status: "expired" }, null, 2));
}

export type Outcome =
  | { status: "approved"; sessionName: string }
  | { status: "rejected" }
  | { status: "expired" };

/**
 * Wait for an answer to that request.
 *
 * Polled rather than watched. A watcher would be more immediate, but this has to
 * end on time whether or not a filesystem event ever arrives, and the deadline
 * is the part that must not be left to chance. Half a second is far below what
 * a person takes to read an approval prompt, so the extra promptness a watcher
 * would buy is not promptness anybody can perceive.
 */
export async function waitForAnswer(args: {
  id: string;
  timeoutSeconds?: number;
  pollMs?: number;
  /** Injected in tests so a timeout does not take ten minutes to prove. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<Outcome> {
  const pollMs = args.pollMs ?? POLL_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = args.now ?? (() => Date.now());
  const deadline = now() + (args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  for (;;) {
    const request = await readRequest(args.id);
    if (!request) {
      // Someone deleted the file. Treated as a refusal rather than an error:
      // the agent's answer is the same either way, that it may not act.
      return { status: "rejected" };
    }
    if (request.status === "approved" && request.answer?.sessionName) {
      return { status: "approved", sessionName: request.answer.sessionName };
    }
    if (request.status === "rejected") return { status: "rejected" };
    if (request.status === "expired") return { status: "expired" };

    if (now() >= deadline || hasExpired(request, now())) {
      await expireRequest(args.id);
      return { status: "expired" };
    }
    await sleep(pollMs);
  }
}

/** Remove a request file. Used after an answer has been reported. */
export async function deleteRequest(id: string): Promise<void> {
  await unlink(requestPath(id)).catch(() => {});
}
