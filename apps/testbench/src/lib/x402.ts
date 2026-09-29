/**
 * Buying one paid request from an x402 seller, as the panel needs it.
 *
 * The SDK's `fetchWithX402` does the whole handshake in one call, which hides
 * the thing the demo is about: which rail the payment took. So the probe is
 * split out, the requirement is chosen with the SDK's own
 * `selectX402Requirement`, and only then is the payment made.
 *
 * Why the rail matters on Celo: `eip3009` settles against Celo Sepolia's USDC,
 * which checks the signature with `ecrecover` and knows nothing about
 * ERC-1271, so an Altana smart account cannot pay on it at all. Permit2 does
 * verify ERC-1271, so that is the smart-account rail. The facilitator only
 * takes eip3009. An agent wallet therefore pays locally, and the facilitator
 * is for EOA buyers (evidence/2026-09-29-x402-celo-facilitator.md).
 */

import { selectX402Requirement, type X402Requirement } from "@altananetwork/sdk";

export type X402Probe = {
  /** Everything the seller said it takes. */
  accepts: X402Requirement[];
  /** The one the SDK would pay, if any of them is payable. */
  chosen?: X402Requirement;
  /** The seller's stated x402 version, from the 402 body. */
  version?: number;
  /** Present when the URL answered something other than a 402. */
  unexpected?: { status: number; body: string };
};

export type Rail = "permit2" | "eip3009";

/** What the seller answered after the payment, as our seller reports it. */
export type X402Payment = {
  status: number;
  rail?: string;
  settledVia?: string;
  settlement?: string;
  txHash?: string;
  payer?: string;
  amount?: string;
  data?: string;
  /** The seller's raw body when it is not our seller's shape. */
  raw?: string;
};

/**
 * Asks the seller what it charges, without paying. A 200 here means the URL is
 * not a paid route, which is worth saying plainly rather than reporting a
 * payment that never happened.
 */
export async function probeX402(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<X402Probe> {
  const res = await fetchImpl(url);
  if (res.status !== 402) {
    return { accepts: [], unexpected: { status: res.status, body: (await res.text()).slice(0, 400) } };
  }
  const body = (await res.json()) as {
    accepts?: X402Requirement[];
    x402Version?: number;
    resource?: string;
    scheme?: string;
  };
  const accepts: X402Requirement[] = Array.isArray(body.accepts)
    ? body.accepts
    : body.scheme
      ? [body as X402Requirement]
      : [];
  return {
    accepts,
    ...(body.x402Version !== undefined ? { version: body.x402Version } : {}),
    ...(() => {
      const chosen = selectX402Requirement(accepts, { chainId: 11142220 });
      return chosen ? { chosen } : {};
    })(),
  };
}

/** Reads our seller's answer, and falls back to the raw body for any other. */
export async function readPaidResponse(res: Response): Promise<X402Payment> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const pick = (k: string) => (typeof json[k] === "string" ? (json[k] as string) : undefined);
    return {
      status: res.status,
      ...(pick("rail") ? { rail: pick("rail")! } : {}),
      ...(pick("settledVia") ? { settledVia: pick("settledVia")! } : {}),
      ...(pick("settlement") ? { settlement: pick("settlement")! } : {}),
      ...(pick("txHash") ? { txHash: pick("txHash")! } : {}),
      ...(pick("payer") ? { payer: pick("payer")! } : {}),
      ...(pick("amount") ? { amount: pick("amount")! } : {}),
      ...(pick("data") ? { data: pick("data")! } : {}),
      raw: text.slice(0, 600),
    };
  } catch {
    return { status: res.status, raw: text.slice(0, 600) };
  }
}

/** One line naming the rail and what it means for this buyer. */
export function railNote(rail: string | undefined): string {
  if (!rail) return "The seller did not say which rail carried the payment.";
  if (rail.startsWith("permit2")) {
    return "Permit2, which verifies an ERC-1271 signature on chain. This is the rail an Altana smart account can pay on, and it settles from the merchant's own key: Celo's facilitator does not take it.";
  }
  if (rail === "eip3009") {
    return "EIP-3009 on USDC, whose signature check is ecrecover only. A plain EOA can pay on it; an Altana smart account cannot. This is the rail Celo's facilitator settles.";
  }
  return `Rail ${rail}.`;
}

/** The seller's own description of itself, from its health route. */
export type SellerHealth = {
  chainId?: number;
  payTo?: string;
  price?: string;
  token?: string;
  rails?: string[];
  facilitator?: string | null;
};

export async function readSellerHealth(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SellerHealth | undefined> {
  try {
    const res = await fetchImpl(new URL("/health", baseUrl).toString());
    if (!res.ok) return undefined;
    return (await res.json()) as SellerHealth;
  } catch {
    return undefined;
  }
}
