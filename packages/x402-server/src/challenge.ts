import type { ChallengeAccept, ChallengeBody, MerchantConfig } from "./types.js";

/** Clamp the quoted price into [minPrice, maxPrice] (mirrors studio.toml semantics). */
export function effectivePrice(cfg: MerchantConfig): bigint {
  let p = cfg.price;
  if (cfg.minPrice != null && p < cfg.minPrice) p = cfg.minPrice;
  if (cfg.maxPrice != null && p > cfg.maxPrice) p = cfg.maxPrice;
  return p;
}

/**
 * Build the 402 challenge body. Every entry uses the real B402 v2 wire shape
 * (`scheme:"exact"`, CAIP-2 network, `extra.assetTransferMethod`) so it is
 * payable by BNB Agent Studio buyers (eip3009/$U) and Altana `fetchWithX402`
 * buyers (permit2-exact) alike.
 */
export function buildChallenge(cfg: MerchantConfig): ChallengeBody {
  const amount = effectivePrice(cfg).toString();
  const network = `eip155:${cfg.chainId}`;
  const timeout = cfg.maxTimeoutSeconds ?? 600;

  const accepts: ChallengeAccept[] = cfg.rails.map((rail) => ({
    scheme: "exact",
    network,
    asset: rail.token.address,
    payTo: cfg.payTo,
    amount,
    maxTimeoutSeconds: timeout,
    extra: {
      name: rail.token.name,
      version: rail.token.version,
      assetTransferMethod: rail.rail,
      ...(rail.rail === "permit2-exact" ? { spenderAddress: rail.spender } : {}),
    },
  }));

  return {
    x402Version: 2,
    error: "payment required",
    ...(cfg.resource ? { resource: cfg.resource } : {}),
    ...(cfg.description ? { description: cfg.description } : {}),
    accepts,
  };
}
