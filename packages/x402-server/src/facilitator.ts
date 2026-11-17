/**
 * Settling through a hosted x402 facilitator instead of the merchant's own key.
 *
 * A merchant settles locally by default: it holds a funded EOA and broadcasts
 * the buyer's authorization itself (`settle.ts`). A facilitator does that for
 * it and pays the gas, so a merchant can take payments without running any
 * chain infrastructure or holding a balance. The trade is trust and liveness:
 * the facilitator sees every payment, decides whether to broadcast it, and its
 * outage is the merchant's outage.
 *
 * Celo runs one, and it is the one Celo's own documentation points at
 * (https://docs.celo.org/build-on-celo/build-with-ai/x402):
 *
 * | Network | Base URL |
 * | --- | --- |
 * | Celo (42220) | `https://api.x402.celo.org` |
 * | Celo Sepolia (11142220) | `https://api.x402.sepolia.celo.org` |
 *
 * Both answer `GET /supported` with `scheme: "exact"` on their CAIP-2 network,
 * which is the shape `buildChallenge` already emits. `POST /verify` is open;
 * `POST /settle` needs an `X-API-Key`, issued at https://x402.celo.org against
 * a signed message.
 *
 * **Which rails it can take is the facilitator's to declare, not ours to
 * assume.** `GET /supported` lists each asset with an `assetTransferMethod`,
 * and Celo's mainnet facilitator advertises `eip3009` for USDC, USDT and USAT
 * and `permit2` for wARS, wBRL and wCOP. So a facilitator is not an EIP-3009
 * thing: `facilitatorRails` reads what it actually claims, and
 * `FacilitatorConfig.rails` decides what to send it.
 *
 * `DEFAULT_FACILITATOR_RAILS` is `["eip3009"]` all the same, because a default
 * should be a rail that is known to work end to end. Measured 2026-10-05
 * against Celo's mainnet `/verify`, with an EIP-3009 payment as the control in
 * the same run: our EIP-3009 payload is accepted (it reaches the balance
 * check), and our Permit2 payload is refused `invalid_format` — their request
 * schema has no variant for the payload we emit, which carries
 * `permit`/`permit2Authorization` where EIP-3009 carries `authorization`. The
 * capability they advertise and the wire shape they accept do not yet meet, and
 * their docs describe neither, so routing Permit2 there is opt-in until that is
 * settled with them.
 *
 * **Verification stays local.** The merchant's own `verifyPayment` is
 * ERC-1271-aware and lets a smart-account buyer through; a facilitator's
 * `/verify` need not be, and a payment it calls invalid is one the merchant can
 * still settle. So the facilitator is asked to settle, not to judge.
 */

import type { DecodedPayment } from "./types.js";
import type { SettleResult } from "./settle.js";

/** A hosted facilitator to settle through. */
export type FacilitatorConfig = {
  /** Base URL, without a trailing path: `https://api.x402.sepolia.celo.org`. */
  url: string;
  /**
   * The `X-API-Key` its `/settle` requires. Without one the facilitator answers
   * 401 and the merchant answers 402 "settlement failed", so a merchant that
   * has no key should settle locally instead of half-configuring this.
   */
  apiKey?: string;
  /**
   * Which rails to send there. Defaults to `DEFAULT_FACILITATOR_RAILS`; every
   * rail not listed settles from the merchant's own key. `facilitatorRails`
   * reads what a facilitator claims, which is what this should usually be set
   * from rather than hardcoded.
   */
  rails?: readonly DecodedPayment["rail"][];
  /** Swap the transport in tests, or to add a proxy or a timeout. */
  fetch?: typeof fetch;
};

/**
 * The rails a facilitator is asked to settle when its config does not say.
 *
 * `eip3009` only, deliberately: it is the one proven end to end against Celo's
 * facilitator. Celo advertises `permit2` for its wrapped currencies, but its
 * `/verify` refuses the Permit2 payload we emit (`invalid_format`), so sending
 * Permit2 there by default would break payments that settle locally today. Pass
 * `rails` to opt in, and `facilitatorRails` to see what a facilitator claims.
 */
export const DEFAULT_FACILITATOR_RAILS: readonly DecodedPayment["rail"][] = ["eip3009"];

/** Celo's own facilitator, per Celo's x402 documentation. */
export const CELO_FACILITATOR_URL = "https://api.x402.celo.org";
/** Celo Sepolia's facilitator, per Celo's x402 documentation. */
export const CELO_SEPOLIA_FACILITATOR_URL = "https://api.x402.sepolia.celo.org";

/** The facilitator for a chain the SDK knows one for. */
export function facilitatorUrlFor(chainId: number): string | undefined {
  if (chainId === 42220) return CELO_FACILITATOR_URL;
  if (chainId === 11142220) return CELO_SEPOLIA_FACILITATOR_URL;
  return undefined;
}

/** Whether this payment is one the facilitator has been asked to settle. */
export function settlesViaFacilitator(rail: DecodedPayment["rail"], facilitator: FacilitatorConfig): boolean {
  return (facilitator.rails ?? DEFAULT_FACILITATOR_RAILS).includes(rail);
}

/** One asset a facilitator lists, with the rail it settles it over. */
export type FacilitatorAsset = {
  asset: string;
  symbol?: string;
  decimals?: number;
  name?: string;
  version?: string;
  assetTransferMethod?: string;
};

/** One `(network, scheme)` pair a facilitator says it takes. */
export type FacilitatorKind = {
  x402Version?: number;
  scheme: string;
  network: string;
  extra?: { supportedAssets?: FacilitatorAsset[]; defaultAsset?: FacilitatorAsset; extensions?: string[] };
};

/**
 * What the facilitator says it supports, from its open `GET /supported`.
 * Worth calling at startup: a merchant pointed at the wrong network gets a
 * clear answer before a buyer pays for one.
 */
export async function facilitatorSupported(
  facilitator: FacilitatorConfig,
): Promise<{ kinds: FacilitatorKind[]; extensions?: string[] }> {
  const doFetch = facilitator.fetch ?? fetch;
  const response = await doFetch(`${base(facilitator.url)}/supported`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`x402 facilitator ${facilitator.url} answered /supported with ${response.status}`);
  }
  const body = (await response.json()) as { kinds?: FacilitatorKind[]; extensions?: string[] };
  return { kinds: body.kinds ?? [], ...(body.extensions ? { extensions: body.extensions } : {}) };
}

/** Whether a facilitator's `/supported` covers `exact` on this chain. */
export function supportsExactOn(
  kinds: readonly FacilitatorKind[],
  chainId: number,
): boolean {
  return kinds.some((k) => k.scheme === "exact" && k.network === `eip155:${chainId}`);
}

/**
 * The assets a facilitator lists for this chain, each with the
 * `assetTransferMethod` it settles them over.
 *
 * Reads the v2 `kinds` entry, because a v1 entry may carry no `extra` at all.
 */
export function facilitatorAssets(
  kinds: readonly FacilitatorKind[],
  chainId: number,
): FacilitatorAsset[] {
  const network = `eip155:${chainId}`;
  const seen = new Map<string, FacilitatorAsset>();
  for (const k of kinds) {
    if (k.scheme !== "exact" || k.network !== network) continue;
    for (const a of k.extra?.supportedAssets ?? []) {
      if (a?.asset) seen.set(a.asset.toLowerCase(), a);
    }
  }
  return [...seen.values()];
}

/**
 * The rails a facilitator claims for this chain, as our rail names.
 *
 * What it *claims*, which is not the same as what its `/verify` accepts — see
 * the note on `DEFAULT_FACILITATOR_RAILS`. Use it to decide what is worth
 * configuring, not as proof a rail will settle.
 */
export function facilitatorRails(
  kinds: readonly FacilitatorKind[],
  chainId: number,
): DecodedPayment["rail"][] {
  const rails: DecodedPayment["rail"][] = [];
  for (const a of facilitatorAssets(kinds, chainId)) {
    const rail = railOf(a.assetTransferMethod);
    if (rail && !rails.includes(rail)) rails.push(rail);
  }
  return rails;
}

/** A facilitator's `assetTransferMethod` as our rail name, when we have one. */
function railOf(method: string | undefined): DecodedPayment["rail"] | undefined {
  if (method === "eip3009") return "eip3009";
  // The two Permit2 variants are different signatures, not spellings: plain
  // `permit2` is a direct PermitTransferFrom, `permit2-exact` binds the
  // recipient in a witness. Celo advertises the plain one.
  if (method === "permit2") return "permit2";
  if (method === "permit2-exact") return "permit2-witness";
  return undefined;
}

/**
 * Hands the buyer's authorization to the facilitator to broadcast.
 *
 * The request is the x402 v2 facilitator body: the buyer's payload exactly as
 * it arrived, and the requirement it chose. Nothing is re-encoded, because the
 * facilitator verifies the signature against what the buyer signed and any
 * normalization of ours would change it.
 *
 * Throws when the payment definitely did not happen, matching `settlePayment`:
 * the merchant then answers 402 and an honest buyer may retry. A success
 * carrying a transaction hash is `confirmed`, and the spec's
 * `settlement_pending` (a broadcast whose outcome is not yet readable) is
 * `pending` with that hash, never an error — a pending payment answered with a
 * fresh challenge makes the buyer pay twice.
 */
export async function settleViaFacilitator(
  decoded: DecodedPayment,
  requirements: Record<string, unknown>,
  facilitator: FacilitatorConfig,
): Promise<SettleResult> {
  const doFetch = facilitator.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${base(facilitator.url)}/settle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(facilitator.apiKey ? { "X-API-Key": facilitator.apiKey } : {}),
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: decoded.raw,
        paymentRequirements: requirements,
      }),
    });
  } catch (e) {
    // The facilitator was unreachable, so nothing was broadcast.
    throw new Error(`x402 facilitator ${facilitator.url} could not be reached: ${(e as Error).message}`);
  }

  const body = await response.json().catch(() => undefined) as FacilitatorSettleResponse | undefined;
  if (!response.ok) {
    // 401 is the one worth naming: it is a missing or rejected API key, not
    // anything about the payment, and it will fail for every buyer.
    const detail =
      response.status === 401
        ? "its /settle rejected the API key (set `apiKey`; Celo issues one at https://x402.celo.org)"
        : `it answered ${response.status}${body?.errorReason ? `: ${body.errorReason}` : ""}`;
    throw new Error(`x402 facilitator ${facilitator.url}: ${detail}`);
  }

  const txHash = typeof body?.transaction === "string" && body.transaction !== "" ? (body.transaction as SettleResult["txHash"]) : undefined;

  if (body?.errorReason === "settlement_pending") {
    if (!txHash) {
      throw new Error(`x402 facilitator ${facilitator.url} reported settlement_pending with no transaction hash`);
    }
    return {
      txHash,
      settlement: "pending",
      pendingReason: "the facilitator has broadcast it and has no receipt yet",
      settledVia: "facilitator",
    };
  }
  if (body?.success !== true) {
    throw new Error(`x402 facilitator ${facilitator.url} refused to settle: ${body?.errorReason ?? "no reason given"}`);
  }
  if (!txHash) {
    throw new Error(`x402 facilitator ${facilitator.url} reported success with no transaction hash`);
  }
  return { txHash, settlement: "confirmed", settledVia: "facilitator" };
}

/** The x402 v2 `SettleResponse`. */
type FacilitatorSettleResponse = {
  success?: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
  amount?: string;
};

function base(url: string): string {
  return url.replace(/\/+$/, "");
}
