/**
 * Parsing and validating a session handed over by somebody else.
 *
 * `grant_session` mints a session here, so the server already holds the key.
 * An agent wallet app is the other direction: the wallet's owner is a passkey in
 * a browser, the app generates the session key and shows it once, and the person
 * pastes it into their agent. There is no admin key on this machine at all, and
 * there never will be.
 *
 * So importing has to work from the two things the app can give out: the
 * serialized session, which carries no secret, and the session private key. Both
 * are needed, because the serialized half alone cannot sign and the key alone
 * cannot tell the relay which permissions were registered. Porto computes a key
 * hash from the permissions and the expiry, so a session rebuilt with anything
 * different is a key the relay has never heard of.
 *
 * Everything here is pure: no keychain, no disk, no network. That is what makes
 * the failure modes testable, and the failure modes are the point, since every
 * input is pasted by hand.
 */

import type { Hex } from "viem";
import type { SerializedSession } from "@altananetwork/sdk";

/** What the app hands over, as one copyable blob. */
export type SessionBundle = {
  v: 1;
  session: SerializedSession;
  privateKey: Hex;
};

export type ParsedImport = {
  session: SerializedSession;
  privateKey: Hex;
};

export class ImportSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportSessionError";
  }
}

const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * Accept either the one-blob form or the two fields separately, because a
 * person pasting from a terminal will do both and neither is wrong.
 *
 * Whitespace is trimmed everywhere: a value copied out of a browser routinely
 * arrives with a trailing newline, and failing on that is a bad first
 * experience with no diagnostic value.
 */
export function parseImport(input: {
  bundle?: string;
  session?: string;
  privateKey?: string;
}): ParsedImport {
  const bundle = input.bundle?.trim();
  const sessionText = input.session?.trim();
  const keyText = input.privateKey?.trim();

  if (bundle) {
    const parsed = parseJson(bundle, "bundle");
    if (!isRecord(parsed)) {
      throw new ImportSessionError("The bundle is not a JSON object.");
    }
    // A bundle that is really just a serialized session is a common mistake:
    // say which half is missing rather than complaining about the shape.
    if (!("session" in parsed) && "publicKey" in parsed) {
      throw new ImportSessionError(
        "That looks like the session half on its own, with no private key in it. " +
          "Pass the key as well, either inside the bundle as privateKey or as the privateKey argument.",
      );
    }
    const version = parsed.v;
    if (version !== undefined && version !== 1) {
      throw new ImportSessionError(
        `This bundle says version ${String(version)}, which this version of the server does not understand. Update @altananetwork/mcp.`,
      );
    }
    const key = keyText ?? asString(parsed.privateKey);
    return {
      session: assertSerializedSession(parsed.session),
      privateKey: assertPrivateKey(key),
    };
  }

  if (!sessionText || !keyText) {
    throw new ImportSessionError(
      "Pass either bundle, or both session and privateKey. The session half carries the " +
        "permissions and expiry the relay registered; the key is what signs. Neither works alone.",
    );
  }

  return {
    session: assertSerializedSession(parseJson(sessionText, "session")),
    privateKey: assertPrivateKey(keyText),
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportSessionError(
      `The ${what} is not valid JSON. Copy the whole value, including the outer braces.`,
    );
  }
}

/**
 * Check the serialized session field by field.
 *
 * Strict on purpose. A session whose permissions differ from the grant by one
 * character produces a key hash the relay has never seen, and the failure shows
 * up later as "key hash unknown" at execute time, which says nothing about the
 * paste that caused it. Better to refuse here, where the message can name the
 * field.
 */
export function assertSerializedSession(value: unknown): SerializedSession {
  if (!isRecord(value)) {
    throw new ImportSessionError("The session is not a JSON object.");
  }

  const walletAddress = asString(value.walletAddress);
  if (!walletAddress || !ADDRESS.test(walletAddress)) {
    throw new ImportSessionError(
      "The session has no valid walletAddress. It should be the agentic wallet's 0x address.",
    );
  }

  const publicKey = asString(value.publicKey);
  if (!publicKey || !HEX.test(publicKey) || publicKey.length <= 2) {
    throw new ImportSessionError("The session has no valid publicKey.");
  }

  const expiry = value.expiry;
  if (typeof expiry !== "number" || !Number.isInteger(expiry) || expiry <= 0) {
    throw new ImportSessionError(
      "The session has no valid expiry. It should be a Unix time in seconds.",
    );
  }

  if (!isRecord(value.permissions)) {
    throw new ImportSessionError("The session has no permissions object.");
  }
  const permissions = parsePermissions(value.permissions);

  return {
    walletAddress: walletAddress as SerializedSession["walletAddress"],
    publicKey: publicKey as Hex,
    permissions,
    expiry,
  };
}

const PERIODS = new Set(["minute", "hour", "day", "week", "month", "year"]);

function parsePermissions(value: Record<string, unknown>): SerializedSession["permissions"] {
  const out: {
    calls?: SerializedSession["permissions"]["calls"];
    spend?: SerializedSession["permissions"]["spend"];
  } = {};

  if (value.calls !== undefined) {
    if (!Array.isArray(value.calls)) {
      throw new ImportSessionError("The session's permissions.calls is not a list.");
    }
    out.calls = value.calls.map((call, i) => {
      if (!isRecord(call)) {
        throw new ImportSessionError(`permissions.calls[${i}] is not an object.`);
      }
      const to = asString(call.to);
      const signature = asString(call.signature);
      if (to !== undefined && !ADDRESS.test(to)) {
        throw new ImportSessionError(`permissions.calls[${i}].to is not an address.`);
      }
      if (to === undefined && signature === undefined) {
        throw new ImportSessionError(
          `permissions.calls[${i}] has neither a "to" nor a "signature", so it allows nothing.`,
        );
      }
      return {
        ...(to !== undefined ? { to } : {}),
        ...(signature !== undefined ? { signature } : {}),
      } as NonNullable<SerializedSession["permissions"]["calls"]>[number];
    });
  }

  if (value.spend !== undefined) {
    if (!Array.isArray(value.spend)) {
      throw new ImportSessionError("The session's permissions.spend is not a list.");
    }
    out.spend = value.spend.map((cap, i) => {
      if (!isRecord(cap)) {
        throw new ImportSessionError(`permissions.spend[${i}] is not an object.`);
      }
      const limit = asString(cap.limit);
      // A decimal string, never a number: a JSON number cannot hold a wei limit
      // without losing precision, and a lossy limit is a different key hash.
      if (!limit || !/^\d+$/.test(limit)) {
        throw new ImportSessionError(
          `permissions.spend[${i}].limit must be a decimal string in the token's smallest unit, ` +
            `for example "1000000000000000". A JSON number cannot hold a wei amount exactly.`,
        );
      }
      const period = asString(cap.period);
      if (!period || !PERIODS.has(period)) {
        throw new ImportSessionError(
          `permissions.spend[${i}].period must be one of ${[...PERIODS].join(", ")}.`,
        );
      }
      const token = asString(cap.token);
      if (token !== undefined && !ADDRESS.test(token)) {
        throw new ImportSessionError(`permissions.spend[${i}].token is not an address.`);
      }
      return {
        limit,
        period: period as NonNullable<SerializedSession["permissions"]["spend"]>[number]["period"],
        ...(token !== undefined ? { token } : {}),
      } as NonNullable<SerializedSession["permissions"]["spend"]>[number];
    });
  }

  return out;
}

export function assertPrivateKey(value: string | undefined): Hex {
  if (!value) {
    throw new ImportSessionError(
      "No private key was given. The app shows it once when the permission is created.",
    );
  }
  const key = value.trim();
  // A missing 0x is the single most common paste error, so fix it rather than
  // refusing: there is no ambiguity about what was meant.
  const prefixed = key.startsWith("0x") ? key : `0x${key}`;
  if (!HEX_32_BYTES.test(prefixed)) {
    throw new ImportSessionError(
      "The private key should be 32 bytes of hex, 64 characters after the 0x. " +
        "Check that the whole value was copied.",
    );
  }
  return prefixed as Hex;
}

/** Has this session already expired? Importing a dead session should say so. */
export function expiryState(
  session: SerializedSession,
  nowSeconds: number,
): { expired: boolean; secondsLeft: number } {
  const secondsLeft = session.expiry - nowSeconds;
  return { expired: secondsLeft <= 0, secondsLeft };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
