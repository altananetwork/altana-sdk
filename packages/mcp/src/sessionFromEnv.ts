/**
 * Taking a session from the environment at startup.
 *
 * The wallet app shows a session key once and tells the person how to give it to
 * their agent. The route has to keep the key out of the agent's chat, so it is
 * handed to this process directly:
 *
 *   ALTANA_SESSION       the serialized session, which carries no key material
 *   ALTANA_SESSION_KEY   the session's private key
 *   ALTANA_SESSION_NAME  optional; what to call it. Defaults to "imported".
 *   ALTANA_SESSION_PERSIST=1  optional; also write it to the keychain and
 *                             ~/.altana, which is otherwise not done
 *
 * Variable names match what the app's credential screen already generates, so
 * the snippet a person copies is the snippet that works.
 */

import type { Hex } from "viem";
import { deserializeSession, signerFromPrivateKey, keyHashForSessionOrKey } from "@altananetwork/sdk";
import { parseImport, expiryState, ImportSessionError } from "./importSession.js";
import { rememberSession } from "./memorySessions.js";
import type { StoredSession } from "./sessions.js";

export const DEFAULT_SESSION_NAME = "imported";

export type EnvSession = {
  name: string;
  session: StoredSession;
  privateKey: Hex;
  keyHash: Hex;
  expired: boolean;
  secondsLeft: number;
  /** True when the caller explicitly asked for it to be written down. */
  persist: boolean;
};

export type EnvSource = {
  session?: string;
  privateKey?: string;
  name?: string;
  persist?: string;
};

export function readEnvSource(env: NodeJS.ProcessEnv = process.env): EnvSource {
  return {
    session: env.ALTANA_SESSION,
    privateKey: env.ALTANA_SESSION_KEY,
    name: env.ALTANA_SESSION_NAME,
    persist: env.ALTANA_SESSION_PERSIST,
  };
}

/**
 * Build the session the environment describes, or nothing when it describes
 * none.
 *
 * Throws when the environment describes one **badly**, rather than starting
 * without it. A server that quietly ignored a malformed session would leave the
 * agent reporting "no session named X" while the person could see they had
 * supplied one, which sends them looking in the wrong place.
 */
export function sessionFromEnv(source: EnvSource = readEnvSource()): EnvSession | undefined {
  const serialized = source.session?.trim();
  const key = source.privateKey?.trim();

  if (!serialized && !key) return undefined;
  if (!serialized || !key) {
    throw new ImportSessionError(
      "Half a session was supplied. ALTANA_SESSION is the serialized session and " +
        "ALTANA_SESSION_KEY is its private key; neither works without the other.",
    );
  }

  const parsed = parseImport({ session: serialized, privateKey: key });
  const signer = signerFromPrivateKey(parsed.privateKey);

  let rebuilt;
  try {
    rebuilt = deserializeSession(parsed.session, signer);
  } catch (err) {
    throw new ImportSessionError(
      "That private key does not belong to that session: its public key does not match. " +
        "Check that both halves came from the same permission. " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const name = source.name?.trim() || DEFAULT_SESSION_NAME;
  const now = Math.floor(Date.now() / 1000);
  const { expired, secondsLeft } = expiryState(parsed.session, now);

  return {
    name,
    session: {
      name,
      // No admin key exists on an agent's machine, which is the whole premise.
      walletName: "imported",
      walletAddress: parsed.session.walletAddress,
      publicKey: parsed.session.publicKey,
      permissions: parsed.session.permissions,
      expiry: parsed.session.expiry,
      createdAt: new Date().toISOString(),
    },
    privateKey: parsed.privateKey,
    keyHash: keyHashForSessionOrKey(rebuilt),
    expired,
    secondsLeft,
    persist: source.persist === "1" || source.persist?.toLowerCase() === "true",
  };
}

/**
 * Register it for this run. Returns the lines worth telling the operator, which
 * go to stderr: stdout is the JSON-RPC channel and anything written there
 * corrupts the protocol.
 */
export function registerEnvSession(found: EnvSession): string[] {
  rememberSession(found.name, found.session, found.privateKey);

  const lines = [
    `[altana-mcp] session "${found.name}" loaded from the environment for ` +
      `${found.session.walletAddress}, keyHash ${found.keyHash.slice(0, 18)}`,
  ];
  if (found.expired) {
    lines.push(
      `[altana-mcp] WARNING: session "${found.name}" expired ` +
        `${new Date(found.session.expiry * 1000).toISOString()}; it is loaded but cannot act. ` +
        `Ask for a fresh permission from the wallet that granted it.`,
    );
  } else {
    lines.push(
      `[altana-mcp] session "${found.name}" expires ` +
        `${new Date(found.session.expiry * 1000).toISOString()} (${Math.floor(found.secondsLeft / 60)} minutes)`,
    );
  }
  lines.push(
    found.persist
      ? `[altana-mcp] ALTANA_SESSION_PERSIST is set, so "${found.name}" will also be written to the keychain.`
      : `[altana-mcp] "${found.name}" is held in memory only and is gone when this process exits.`,
  );
  return lines;
}
