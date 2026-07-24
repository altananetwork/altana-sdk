import type { Address, Hex, TypedDataDefinition } from "viem";
import {
  buildEip3009TypedData,
  buildPermit2TypedData,
  buildPermit2WitnessTypedData,
} from "@altananetwork/sdk";
import { effectivePrice } from "./challenge.js";
import type { DecodedPayment, MerchantConfig, RailConfig, VerifyResult } from "./types.js";

export type VerifySignatureFn = (args: {
  address: Address;
  signature: Hex;
} & TypedDataDefinition) => Promise<boolean> | boolean;

export type VerifyOptions = {
  /** Unix seconds "now" (tests); defaults to the wall clock. */
  now?: number;
  /**
   * Signature verifier. Pass `publicClient.verifyTypedData` (viem) to support
   * EOA + ERC-1271 + ERC-6492 payers; the pure `verifyTypedData` covers EOAs
   * only. REQUIRED so the choice of trust model is explicit.
   */
  verifySignature: VerifySignatureFn;
  /**
   * Is the payer a contract account? When set and the off-chain signature
   * check fails for a contract payer, verification DEFERS to settlement:
   * checker-restricted ERC-1271 accounts (e.g. Altana session keys) only
   * answer `isValidSignature` to their approved checker (Permit2 / the token),
   * so the settling contract is the one true verifier. An invalid signature
   * then simply reverts the settlement transaction.
   */
  isContract?: (address: Address) => Promise<boolean> | boolean;
};

function matchRail(cfg: MerchantConfig, d: DecodedPayment): RailConfig | undefined {
  if (d.rail === "eip3009") {
    return cfg.rails.find(
      (r) =>
        r.rail === "eip3009" &&
        (d.token === "0x0000000000000000000000000000000000000000" ||
          r.token.address.toLowerCase() === d.token.toLowerCase()),
    );
  }
  return cfg.rails.find(
    (r) => r.rail === "permit2-exact" && r.token.address.toLowerCase() === d.token.toLowerCase(),
  );
}

/**
 * Verify a decoded payment against the merchant config — token/amount/payTo/
 * expiry business rules first (cheap), then the cryptographic signature.
 * Settlement is the on-chain source of truth for nonce replay; this function
 * makes sure only payments worth broadcasting reach it.
 */
export async function verifyPayment(
  d: DecodedPayment,
  cfg: MerchantConfig,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));

  if (d.chainId != null && d.chainId !== cfg.chainId) {
    return { ok: false, reason: `wrong chain: payment is for ${d.chainId}, merchant is on ${cfg.chainId}` };
  }

  const rail = matchRail(cfg, d);
  if (!rail) {
    return { ok: false, reason: `token ${d.token} is not offered on any configured rail` };
  }
  const token = rail.token;

  const price = effectivePrice(cfg);
  if (d.amount < price) {
    return { ok: false, reason: `amount ${d.amount} below the quoted price ${price}` };
  }
  if (cfg.maxPrice != null && d.amount > cfg.maxPrice) {
    return { ok: false, reason: `amount ${d.amount} above maxPrice ${cfg.maxPrice}` };
  }

  let typedData: TypedDataDefinition;

  if (d.rail === "eip3009") {
    const a = d.authorization!;
    if (a.to.toLowerCase() !== cfg.payTo.toLowerCase()) {
      return { ok: false, reason: `payTo mismatch: authorization pays ${a.to}, merchant is ${cfg.payTo}` };
    }
    if (BigInt(a.validBefore) <= now) return { ok: false, reason: "authorization expired (validBefore in the past)" };
    if (BigInt(a.validAfter) >= now) return { ok: false, reason: "authorization not yet valid (validAfter in the future)" };
    typedData = buildEip3009TypedData({
      chainId: cfg.chainId,
      token: token.address,
      name: token.name,
      version: token.version,
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    });
  } else {
    const p = d.permit!;
    if (rail.rail !== "permit2-exact" || p.spender.toLowerCase() !== rail.spender.toLowerCase()) {
      return { ok: false, reason: `permit spender ${p.spender} is not the configured settler` };
    }
    if (BigInt(p.deadline) <= now) return { ok: false, reason: "permit expired (deadline in the past)" };
    const base = {
      chainId: cfg.chainId,
      token: p.permitted.token,
      amount: BigInt(p.permitted.amount),
      spender: p.spender,
      nonce: BigInt(p.nonce),
      deadline: BigInt(p.deadline),
    };
    if (d.rail === "permit2-witness") {
      if (p.witness!.to.toLowerCase() !== cfg.payTo.toLowerCase()) {
        return { ok: false, reason: `payTo mismatch: witness pays ${p.witness!.to}, merchant is ${cfg.payTo}` };
      }
      if (BigInt(p.witness!.validAfter) >= now) {
        return { ok: false, reason: "permit not yet valid (witness validAfter in the future)" };
      }
      typedData = buildPermit2WitnessTypedData({
        ...base,
        to: p.witness!.to,
        validAfter: BigInt(p.witness!.validAfter),
      });
    } else {
      typedData = buildPermit2TypedData(base);
    }
  }

  let valid = false;
  try {
    valid = await opts.verifySignature({ address: d.payer, signature: d.signature, ...typedData });
  } catch {
    valid = false;
  }
  if (!valid && opts.isContract) {
    // Checker-restricted smart accounts can't be pre-verified off-chain; the
    // settlement contract (Permit2 / the token) is the authoritative verifier.
    try {
      valid = await opts.isContract(d.payer);
    } catch {
      valid = false;
    }
  }
  if (!valid) return { ok: false, reason: "signature verification failed" };

  return { ok: true, rail: d.rail, payer: d.payer, amount: d.amount, token: token.address };
}
