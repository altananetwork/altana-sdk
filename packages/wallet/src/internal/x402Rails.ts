/**
 * The pieces of x402 that both the payment path and the approval check need: the
 * Permit2 address, the requirement shape off the wire, which chain a network
 * names, and which rail a requirement asks for.
 *
 * They live here rather than in `x402.ts` so that `x402Approvals.ts` and
 * `x402.ts` can each use them without importing each other. A cycle between two
 * published modules works in ESM only because both happen to touch the other's
 * exports inside function bodies; it is not worth relying on.
 */
import type { Address } from "viem";

/** Canonical Permit2 — identical on every chain. */
export const PERMIT2_ADDRESS: Address =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export type X402Resource = {
  url: string;
  description?: string;
  mimeType?: string;
};

/**
 * A single payment option from an HTTP 402 response body (`accepts[i]`).
 *
 * Real Binance B402 always sends `scheme: "exact"` and puts the actual rail in
 * `extra.assetTransferMethod` ("eip3009" | "permit2-exact"), amounts in `amount`,
 * networks as CAIP-2 (`eip155:56`), and the Permit2 settler in
 * `extra.spenderAddress`. We also accept the legacy shape (`scheme: "permit2"`,
 * `maxAmountRequired`, `extra.spender`) the sample/mock used.
 */
export type X402Requirement = {
  scheme: string;
  network: string;
  asset: Address;
  /** Amount in atomic token units (legacy field). */
  maxAmountRequired?: string;
  /** Amount in atomic token units (real B402 field). */
  amount?: string;
  payTo: Address;
  maxTimeoutSeconds?: number;
  /**
   * Echoed into the X-PAYMENT so it matches the challenge. A v2
   * `PaymentRequirements` carries no version of its own (it lives on the 402
   * body), so this is transport-only: `fetchWithX402` copies the body's version
   * down onto the requirement it picks, and `signX402Payment` assumes 2 when
   * nobody says otherwise. Set it, or `opts.x402Version`, to sign for a v1
   * merchant.
   */
  x402Version?: number;
  /**
   * What the payment buys. Carried from the 402 body (top-level `resource`) so
   * `signX402Payment` can echo it — b402 merchants reject an envelope without
   * it ("payment header resource is null"). Transport-only, like x402Version:
   * stripped from `accepted` so that mirrors the requirement verbatim.
   */
  resource?: X402Resource | string;
  /** Content type of the resource, when the challenge carries it separately. */
  mimeType?: string;
  extra?: {
    /** EIP-3009 / permit2 token EIP-712 domain. */
    name?: string;
    version?: string;
    /** Real B402 rail selector: "eip3009" | "permit2-exact". */
    assetTransferMethod?: string;
    /** Permit2 settler bound as `spender` — legacy name. */
    spender?: Address;
    /** Permit2 settler bound as `spender` — real B402 name. */
    spenderAddress?: Address;
    /** Facilitator's configured signer (informational). */
    signerAddress?: Address;
  };
};

/**
 * Map an x402 network to a chainId. Accepts CAIP-2 (`eip155:56`, the real B402
 * wire) and the legacy short names.
 */
export function networkToChainId(network: string): number {
  const caip2 = /^eip155:(\d+)$/.exec(network);
  if (caip2) return Number(caip2[1]);
  switch (network) {
    case "bsc":
    case "binance":
    case "bnb":
      return 56;
    case "base":
      return 8453;
    case "ethereum":
    case "mainnet":
      return 1;
    case "bsc-testnet":
    case "bnb-testnet":
      return 97;
    case "celo":
      return 42220;
    case "celo-sepolia":
      return 11142220;
    default:
      throw new Error(`x402: unsupported network "${network}".`);
  }
}

/** Which rail a requirement names: the permit2 family, or EIP-3009. */
export function resolveRail(req: X402Requirement): "permit2" | "eip3009" {
  const method = req.extra?.assetTransferMethod;
  if (method === "permit2-exact" || method === "permit2") return "permit2";
  if (method === "eip3009") return "eip3009";
  // Legacy fallback: our sample used scheme "permit2"; standard x402 "exact".
  if (req.scheme === "permit2") return "permit2";
  if (req.scheme === "exact") return "eip3009";
  throw new Error(
    `x402: cannot resolve rail for scheme "${req.scheme}"` +
      ` / assetTransferMethod "${method ?? "none"}" (expected permit2-exact or eip3009).`,
  );
}
