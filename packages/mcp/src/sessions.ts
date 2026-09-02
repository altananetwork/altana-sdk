/**
 * Session metadata store for the MCP server.
 *
 * Granting a session produces more state than just a private key — the SDK
 * needs the exact permissions and expiry that were registered on-chain
 * (Porto's relay computes a key hash from these fields, and a mismatch
 * means "key hash unknown" at execute time). We persist that metadata in
 * ~/.altana/sessions.json so subsequent session_execute calls can
 * reconstruct the right Session object.
 *
 * Session private keys live in the OS keychain under the same naming
 * conventions as wallets (`@napi-rs/keyring`). This module only stores
 * metadata.
 *
 * File format:
 * {
 *   "v": 1,
 *   "sessions": [
 *     {
 *       "name": "uniswap-bot",
 *       "walletName": "default",
 *       "walletAddress": "0x...",
 *       "permissions": { "calls": [...], "spend": [...] },
 *       "expiry": 1719999999,
 *       "createdAt": "2026-05-12T..."
 *     }
 *   ]
 * }
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SerializedSession } from "@altananetwork/sdk";

const SESSIONS_DIR = join(homedir(), ".altana");
const SESSIONS_FILE = join(SESSIONS_DIR, "sessions.json");

/** Re-exported for callers that only need the permissions shape. */
export type SessionPermissions = SerializedSession["permissions"];

/**
 * A SerializedSession (the SDK's JSON-safe session half — no key material)
 * plus this server's own metadata. The session private key lives in the OS
 * keychain via keys.ts, never in this file.
 */
export type StoredSession = SerializedSession & {
  name: string;
  walletName: string;
  createdAt: string;
};

type SessionsFile = {
  v: 1;
  sessions: StoredSession[];
};

async function ensureDir() {
  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

async function readFileOrEmpty(): Promise<SessionsFile> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionsFile>;
    return { v: 1, sessions: parsed.sessions ?? [] };
  } catch {
    return { v: 1, sessions: [] };
  }
}

async function writeAtomic(data: SessionsFile) {
  await ensureDir();
  await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  // chmod again in case writeFile didn't honor mode (some filesystems).
  await chmod(SESSIONS_FILE, 0o600).catch(() => {});
}

/** Read every stored session — names + metadata only, no private keys here. */
export async function listSessions(): Promise<StoredSession[]> {
  const file = await readFileOrEmpty();
  return file.sessions;
}

/** Look up a session by name. Throws if missing. */
export async function getSession(name: string): Promise<StoredSession> {
  const file = await readFileOrEmpty();
  const s = file.sessions.find((x) => x.name === name);
  if (!s) {
    throw new Error(
      `No session named "${name}" in ${SESSIONS_FILE}. Use grant_session ` +
        `to create one, or list_sessions to see what's saved.`,
    );
  }
  return s;
}

/** Persist a new session. Overwrites if name already exists. */
export async function saveSession(s: StoredSession): Promise<void> {
  const file = await readFileOrEmpty();
  const next = file.sessions.filter((x) => x.name !== s.name);
  next.push(s);
  await writeAtomic({ v: 1, sessions: next });
}

/** Delete a session by name. Idempotent. */
export async function deleteSession(name: string): Promise<void> {
  const file = await readFileOrEmpty();
  const next = file.sessions.filter((x) => x.name !== name);
  await writeAtomic({ v: 1, sessions: next });
}
