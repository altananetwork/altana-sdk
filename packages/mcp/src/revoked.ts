/**
 * `~/.altana/revoked/<name>.json`: a permission that used to be here.
 *
 * Revoking deletes the session and its key, which leaves the agent's next
 * `session_execute` with nothing to look at. Without a marker the honest answer
 * it can give is "no session named trading-bot", which is true and useless: it
 * reads as a bug or a typo, when what happened is that the person took the
 * permission away deliberately. The difference matters most in exactly the
 * situation where somebody is watching, which is G6.
 *
 * What this is not: authority. The account contract on chain is what refuses a
 * revoked key, and a marker file nobody can forge is not something to lean on
 * for that. This only chooses the wording of a failure that has already
 * happened.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { altanaHome } from "./keys.js";

export function revokedDir(): string {
  return join(altanaHome(), "revoked");
}

/** Which side removed it. The agent's answer differs, so the file records it. */
export type RevokedBy = "extension" | "agent";

export type RevokedMarker = {
  v: 1;
  name: string;
  revokedAt: string;
  by: RevokedBy;
};

/** How long a marker is worth keeping. Long enough to explain, not to archive. */
export const PRUNE_AFTER_DAYS = 7;

function markerPath(name: string): string {
  // A session name reaches this from a request payload, so it cannot be dropped
  // into a path unexamined: a name with a slash or a dot dot in it would write
  // outside the directory. Encoding also means a name that is legal on the wire
  // but awkward on a filesystem still round trips.
  return join(revokedDir(), `${encodeURIComponent(name)}.json`);
}

/** Record that a session was revoked. Overwrites an older marker of the same name. */
export async function markRevoked(args: { name: string; by: RevokedBy }): Promise<RevokedMarker> {
  const marker: RevokedMarker = {
    v: 1,
    name: args.name,
    revokedAt: new Date().toISOString(),
    by: args.by,
  };
  await mkdir(revokedDir(), { recursive: true, mode: 0o700 });
  const path = markerPath(args.name);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return marker;
}

/**
 * The marker for that name, if there is one.
 *
 * Reading is also when pruning happens. A separate sweep would be another thing
 * to schedule and get wrong, and the only moment this directory's size matters
 * is when something is reading it.
 */
export async function readRevoked(name: string): Promise<RevokedMarker | undefined> {
  const marker = await parseMarker(markerPath(name));
  void pruneOldMarkers();
  if (!marker) return undefined;
  return isStale(marker) ? undefined : marker;
}

async function parseMarker(path: string): Promise<RevokedMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RevokedMarker>;
    if (typeof parsed.name !== "string" || typeof parsed.revokedAt !== "string") return undefined;
    return {
      v: 1,
      name: parsed.name,
      revokedAt: parsed.revokedAt,
      by: parsed.by === "agent" ? "agent" : "extension",
    };
  } catch {
    return undefined;
  }
}

function isStale(marker: RevokedMarker, now = Date.now()): boolean {
  const at = Date.parse(marker.revokedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/** Delete markers past their keeping time. Best effort, never throws. */
export async function pruneOldMarkers(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(revokedDir());
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    const path = join(revokedDir(), file);
    const marker = await parseMarker(path);
    // A file that will not parse is also swept: it can never produce a better
    // answer than its absence would.
    if (!marker || isStale(marker)) {
      await unlink(path).then(
        () => {
          pruned += 1;
        },
        () => {},
      );
    }
  }
  return pruned;
}

/** Forget a marker, for when a permission of the same name is granted again. */
export async function clearRevoked(name: string): Promise<void> {
  await unlink(markerPath(name)).catch(() => {});
}

/**
 * The sentence the agent gets when it tries to use a permission that is gone.
 *
 * Written here rather than at the call site so the two callers that need it
 * cannot drift, and worded to be the end of the matter: an agent that reads
 * this should tell the person and stop, not retry or go looking for another
 * way through.
 */
export function revokedMessage(marker: RevokedMarker): string {
  const when = marker.revokedAt;
  const who =
    marker.by === "extension"
      ? "from the Altana extension, by the person who owns the wallet"
      : "by this agent";
  return (
    `The permission "${marker.name}" was revoked ${who} at ${when}, so it no longer ` +
    `exists and cannot be used. This is not a fault to retry or work around: the ` +
    `authority was taken away deliberately. Tell the person it was revoked. If the ` +
    `work still needs doing, request_permission asks them for a new one.`
  );
}
