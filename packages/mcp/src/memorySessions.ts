/**
 * Sessions held in memory for the life of the process, never written down.
 *
 * This exists so a session key can reach an agent **without passing through the
 * agent's chat**. Pasting a key into an `import_session` tool call sends it to
 * whichever model provider the agent runs on, which is the one place a key for
 * somebody's wallet must never go. Handing it to the server as an environment
 * variable at startup keeps it between the person and the process.
 *
 * It is also why nothing here touches the keychain or `~/.altana`. A key the
 * person pasted into a shell command is theirs to hold; writing it to disk on
 * their behalf makes a copy they did not ask for and may not know about. Opting
 * in is a separate, explicit thing.
 *
 * Checked before the keychain and before `sessions.json`, so a session supplied
 * for this run wins over a stale one of the same name left behind by an earlier
 * `grant_session`.
 */

import type { Hex } from "viem";
import type { StoredSession } from "./sessions.js";

type Held = { session: StoredSession; privateKey: Hex };

const held = new Map<string, Held>();

export function rememberSession(name: string, session: StoredSession, privateKey: Hex): void {
  held.set(name, { session, privateKey });
}

export function heldSession(name: string): StoredSession | undefined {
  return held.get(name)?.session;
}

export function heldSessionKey(name: string): Hex | undefined {
  return held.get(name)?.privateKey;
}

export function heldSessionNames(): string[] {
  return [...held.keys()];
}

export function allHeldSessions(): StoredSession[] {
  return [...held.values()].map((h) => h.session);
}

/** Tests only. */
export function forgetHeldSessions(): void {
  held.clear();
}
