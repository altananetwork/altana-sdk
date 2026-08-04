import type { Address, Hex } from "viem";
import type { DecodedPayment } from "./types.js";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;

function asAddress(v: unknown, field: string): Address {
  if (typeof v !== "string" || !ADDR.test(v)) {
    throw new Error(`X-PAYMENT: missing/invalid address in ${field}`);
  }
  return v as Address;
}

function asHex(v: unknown, field: string): Hex {
  if (typeof v !== "string" || !HEX.test(v)) {
    throw new Error(`X-PAYMENT: missing/invalid hex in ${field}`);
  }
  return v as Hex;
}

function asNumeric(v: unknown, field: string): string {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d+$/.test(s)) {
    throw new Error(`X-PAYMENT: missing/invalid integer in ${field}`);
  }
  return s;
}

function chainIdOf(envelope: Record<string, unknown>, accepted: Record<string, unknown> | undefined): number | undefined {
  for (const net of [accepted?.network, envelope.network]) {
    if (typeof net === "string") {
      const m = /^eip155:(\d+)$/.exec(net);
      if (m) return Number(m[1]);
    }
  }
  const cid = accepted?.chainId ?? envelope.chainId;
  if (cid != null && /^\d+$/.test(String(cid))) return Number(cid);
  return undefined;
}

/**
 * Decode and normalize an `X-PAYMENT` header.
 *
 * Tolerates both buyer envelope dialects:
 *  - Studio: `{x402Version, resource, accepted, payload:{signature, authorization}}`
 *  - Altana: `{x402Version, scheme, network, resource?, accepted?, payload:{signature, authorization | from+permit}}`
 *  - b402:   permit2 authorizations arrive as `payload.permit2Authorization`
 *            with `from` nested inside, rather than `permit` + `payload.from`.
 *
 * Throws on malformed input; business-rule checks live in `verifyPayment`.
 */
export function decodeXPayment(header: string): DecodedPayment {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error("X-PAYMENT is not base64-encoded JSON");
  }
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("X-PAYMENT: envelope is not an object");
  }

  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) throw new Error("X-PAYMENT: missing payload");
  const accepted = envelope.accepted as Record<string, unknown> | undefined;
  const signature = asHex(payload.signature, "payload.signature");
  const chainId = chainIdOf(envelope, accepted);

  // eip3009: payload.authorization (both dialects use the same inner shape).
  if (payload.authorization) {
    const a = payload.authorization as Record<string, unknown>;
    const authorization = {
      from: asAddress(a.from, "authorization.from"),
      to: asAddress(a.to, "authorization.to"),
      value: asNumeric(a.value, "authorization.value"),
      validAfter: asNumeric(a.validAfter, "authorization.validAfter"),
      validBefore: asNumeric(a.validBefore, "authorization.validBefore"),
      nonce: asHex(a.nonce, "authorization.nonce"),
    };
    const token = accepted?.asset != null ? asAddress(accepted.asset, "accepted.asset") : undefined;
    return {
      rail: "eip3009",
      payer: authorization.from,
      amount: BigInt(authorization.value),
      // eip3009 verification/settlement resolves the token from the matched
      // rail config; `accepted.asset` is the buyer's claim of it.
      token: token ?? ("0x0000000000000000000000000000000000000000" as Address),
      signature,
      chainId,
      authorization,
      accepted,
      raw: envelope,
    };
  }

  // permit2 / permit2-witness. Two dialects carry the same authorization:
  //  - Altana: `payload.permit` + a sibling `payload.from`
  //  - b402:   `payload.permit2Authorization` with `from` nested inside
  // Our buyer emits both; third-party b402 buyers send only the latter.
  const permitField = payload.permit ?? payload.permit2Authorization;
  if (permitField) {
    const p = permitField as Record<string, unknown>;
    const permitted = p.permitted as Record<string, unknown> | undefined;
    if (!permitted) throw new Error("X-PAYMENT: missing permit.permitted");
    const witness = p.witness as Record<string, unknown> | undefined;
    const permit = {
      permitted: {
        token: asAddress(permitted.token, "permit.permitted.token"),
        amount: asNumeric(permitted.amount, "permit.permitted.amount"),
      },
      spender: asAddress(p.spender, "permit.spender"),
      nonce: asNumeric(p.nonce, "permit.nonce"),
      deadline: asNumeric(p.deadline, "permit.deadline"),
      ...(witness
        ? {
            witness: {
              to: asAddress(witness.to, "permit.witness.to"),
              validAfter: asNumeric(witness.validAfter, "permit.witness.validAfter"),
            },
          }
        : {}),
    };
    return {
      rail: witness ? "permit2-witness" : "permit2",
      payer: asAddress(payload.from ?? p.from, "payload.from"),
      amount: BigInt(permit.permitted.amount),
      token: permit.permitted.token,
      signature,
      chainId,
      permit,
      accepted,
      raw: envelope,
    };
  }

  throw new Error(
    "X-PAYMENT: payload carries neither authorization (eip3009) nor permit/permit2Authorization (permit2)",
  );
}
