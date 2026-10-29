/**
 * Storing a session somebody else granted.
 *
 * There are three ways one arrives now and they must all leave the same state
 * behind, or `session_execute` works for sessions that came one way and not
 * another:
 *
 *   `import_session`, pasted into the agent by hand.
 *   `sendSession`, pushed from the extension through the native host.
 *   `answerRequest`, when somebody approves a request the agent made.
 *
 * So the writing happens once, here, and all three call it. That is the whole
 * point of this file: the contract promises that after a `sendSession` the MCP's
 * next `list_sessions` and `session_execute` see it, and the only way to be sure
 * is for the host to write exactly what `import_session` writes.
 *
 * The order matters and is not accidental. Everything that can be refused is
 * refused before anything is written, so a bad handover leaves no half stored
 * session behind for somebody to find later and wonder about.
 */

import { keccak256 } from "viem";
import type { Hex } from "viem";
import {
  deserializeSession,
  keyHashForSessionOrKey,
  serializeSession,
  signerFromPrivateKey,
  type SerializedSession,
} from "@altananetwork/sdk";
import { setSessionKey, sessionKeyExists } from "./keys.js";
import { clearRevoked } from "./revoked.js";
import { saveSession } from "./sessions.js";

/** A name is already taken. Separate because the wire has a code for it. */
export class SessionNameTakenError extends Error {
  constructor(name: string) {
    super(
      `A session named "${name}" already exists. Pick a different name, or remove ` +
        `the existing one first with revoke_session.`,
    );
    this.name = "SessionNameTakenError";
  }
}

/** The two halves do not belong together, or one of them is malformed. */
export class SessionHandoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionHandoverError";
  }
}

export type StoredHandover = {
  sessionName: string;
  walletAddress: string;
  sessionAddress: string;
  sessionPublicKey: Hex;
  keyHash: string;
  keyId: Hex;
  permissions: SerializedSession["permissions"];
  expiry: number;
  expiresAt: string;
  expired: boolean;
  secondsLeft?: number;
};

/**
 * Store a session and its key under `sessionName`.
 *
 * Never logs, returns or throws the private key. The only thing that leaves
 * here is what is safe to show: the session's address, its public key and the
 * key hash the relay matches transactions against.
 */
export async function storeHandedOverSession(args: {
  sessionName: string;
  session: SerializedSession;
  privateKey: Hex;
  /** Label for `walletName`. "imported" unless a caller has a better one. */
  via?: string;
}): Promise<StoredHandover> {
  const { sessionName } = args;

  // Checked first. Never silently replace a session somebody is already using:
  // the name is what session_execute is given, so overwriting it would quietly
  // repoint an agent's authority at a different permission.
  if (await sessionKeyExists(sessionName)) {
    throw new SessionNameTakenError(sessionName);
  }

  // The real check, and the reason it runs before any write: deserializeSession
  // refuses a key whose public half does not match the session's. Porto derives
  // a key hash from the permissions and the expiry, so a session rebuilt from
  // mismatched halves is a key the relay has never heard of, and that failure
  // would otherwise surface much later as "key hash unknown" at execute time.
  const signer = signerFromPrivateKey(args.privateKey);
  let rebuilt;
  try {
    rebuilt = deserializeSession(args.session, signer);
  } catch (err) {
    throw new SessionHandoverError(
      "That private key does not belong to that session: its public key does not " +
        "match the session's. Check that both halves came from the same permission. " +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = args.session.expiry <= now;
  const secondsLeft = Math.max(0, args.session.expiry - now);

  await setSessionKey(sessionName, args.privateKey);
  // A name can be used again, and here is the one place every route in goes
  // through. Without this a fresh permission under a name that was revoked
  // once would be reported as revoked the moment anything else went wrong with
  // it, which is a confusing answer about a permission that is perfectly live.
  await clearRevoked(sessionName);
  await saveSession({
    name: sessionName,
    // An imported session has no admin wallet here: the owner is a key in
    // somebody's extension. session_execute needs only the session half and its
    // key, so this is a label and never a lookup.
    walletName: args.via ?? "imported",
    walletAddress: args.session.walletAddress,
    publicKey: args.session.publicKey,
    permissions: args.session.permissions,
    expiry: args.session.expiry,
    createdAt: new Date().toISOString(),
  });

  return {
    sessionName,
    walletAddress: args.session.walletAddress,
    sessionAddress: signer.address,
    sessionPublicKey: args.session.publicKey,
    keyHash: keyHashForSessionOrKey(rebuilt),
    keyId: keccak256(args.session.publicKey),
    permissions: args.session.permissions,
    expiry: args.session.expiry,
    expiresAt: new Date(args.session.expiry * 1000).toISOString(),
    expired,
    ...(expired ? {} : { secondsLeft }),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** The handover shape in `packages/contracts/native-messaging.md`. */
export type SessionHandoff = {
  name: string;
  chainId: number;
  walletAddress: string;
  serializedSession: string;
  sessionPrivateKey: Hex;
};

/**
 * Read a `SessionHandoff` off the wire.
 *
 * Every message here has to be safe to log, so none of them ever quotes the
 * value it is complaining about: one of the fields is a private key, and a
 * validator that echoes its input is how a key reaches a log file.
 */
export function parseHandoff(payload: unknown): SessionHandoff {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SessionHandoverError("A session handover has to be an object.");
  }
  const raw = payload as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new SessionHandoverError("The handover has no name to store the session under.");

  const chainId = Number(raw.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new SessionHandoverError("The handover needs a chainId, as a positive whole number.");
  }

  const walletAddress = typeof raw.walletAddress === "string" ? raw.walletAddress.trim() : "";
  if (!ADDRESS.test(walletAddress)) {
    throw new SessionHandoverError("The handover's walletAddress is not an address.");
  }

  const key = typeof raw.sessionPrivateKey === "string" ? raw.sessionPrivateKey.trim() : "";
  if (!PRIVATE_KEY.test(key)) {
    // Says what is wrong with it without saying what it was.
    throw new SessionHandoverError(
      "The handover's sessionPrivateKey is not a 32 byte hex value.",
    );
  }

  if (typeof raw.serializedSession !== "string" || raw.serializedSession.trim().length === 0) {
    throw new SessionHandoverError("The handover has no serializedSession.");
  }

  return {
    name,
    chainId,
    walletAddress,
    serializedSession: raw.serializedSession,
    sessionPrivateKey: key as Hex,
  };
}

/**
 * The serialized half, parsed and checked against the rest of the handover.
 *
 * The cross check earns its place: a handover whose walletAddress disagrees
 * with the session inside it is a mispaired message, and storing it would
 * produce a session that signs for a wallet the extension is not showing.
 */
export function sessionFromHandoff(handoff: SessionHandoff): SerializedSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(handoff.serializedSession);
  } catch (err) {
    throw new SessionHandoverError(
      `The handover's serializedSession is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SessionHandoverError("The handover's serializedSession is not a JSON object.");
  }
  const session = parsed as Partial<SerializedSession>;
  if (typeof session.walletAddress !== "string" || !ADDRESS.test(session.walletAddress)) {
    throw new SessionHandoverError("The serialized session has no walletAddress.");
  }
  if (typeof session.publicKey !== "string" || !session.publicKey.startsWith("0x")) {
    throw new SessionHandoverError("The serialized session has no publicKey.");
  }
  if (typeof session.expiry !== "number" || !Number.isFinite(session.expiry)) {
    throw new SessionHandoverError("The serialized session has no expiry.");
  }
  if (session.permissions === undefined || session.permissions === null) {
    throw new SessionHandoverError("The serialized session has no permissions.");
  }
  if (session.walletAddress.toLowerCase() !== handoff.walletAddress.toLowerCase()) {
    throw new SessionHandoverError(
      `The handover says the wallet is ${handoff.walletAddress} but the session inside ` +
        `it was granted by ${session.walletAddress}. Those have to be the same wallet.`,
    );
  }
  return session as SerializedSession;
}

/** Re-exported so a caller can round trip a session it just rebuilt. */
export { serializeSession };
