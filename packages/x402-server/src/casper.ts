/**
 * Casper Network rail for the seller side.
 *
 * Casper is not EVM: accounts are ed25519/secp256k1 public keys (and 32-byte
 * account hashes), the settlement asset is a CEP-18 token, and payments settle
 * as Casper transactions rather than EVM calldata. None of that fits the
 * `viem`-typed EIP-3009/Permit2 paths in `challenge.ts` / `verify.ts` /
 * `settle.ts`, which are hard-wired to `eip155:<chainId>` networks and 20-byte
 * addresses — so this module is a parallel, self-contained rail rather than a
 * widening of those types. The EVM code paths are untouched.
 *
 * Verification and settlement are delegated over HTTP to an x402 facilitator
 * for Casper (CSPR.cloud runs one at https://x402-facilitator.cspr.cloud),
 * which checks the EIP-712 `TransferAuthorization` signature against the
 * payer's Casper public key and submits the CEP-18
 * `transfer_with_authorization` transaction. That means a merchant needs no
 * Casper node connectivity and holds no Casper key.
 *
 * Wire shapes follow the x402 v2 facilitator interface as documented at
 * https://docs.cspr.cloud/x402-facilitator-api/reference.
 */

/** CAIP-2 identifiers for the Casper networks the facilitator settles on. */
export const CASPER_MAINNET = "casper:casper";
export const CASPER_TESTNET = "casper:casper-test";

export type CasperNetwork = typeof CASPER_MAINNET | typeof CASPER_TESTNET | (string & {});

/** Public CSPR.cloud facilitator (mainnet + testnet). */
export const CASPER_FACILITATOR_URL = "https://x402-facilitator.cspr.cloud";

/**
 * A Casper account hash: 32 bytes of hex, optionally carrying the `00`
 * key-tag prefix the facilitator uses (`00<64 hex>`) or the human-readable
 * `account-hash-` prefix.
 */
const ACCOUNT_HASH = /^(?:account-hash-)?(?:00)?[0-9a-fA-F]{64}$/;
/** CEP-18 contract package hash, 64 hex chars. */
const PACKAGE_HASH = /^(?:hash-)?[0-9a-fA-F]{64}$/;
const HEX = /^[0-9a-fA-F]+$/;

/**
 * A CEP-18 settlement token.
 *
 * `name`/`version` are not decoration: the facilitator rebuilds the EIP-712
 * domain from them to recompute the digest the payer signed, and rejects the
 * payload with `missing_token_name` / `missing_token_version` if absent.
 * wCSPR is the usual choice; the package hash differs per network, so it is
 * configuration rather than a constant baked into the SDK.
 */
export type CasperTokenConfig = {
  /** CEP-18 contract package hash (64 hex chars). */
  asset: string;
  /** EIP-712 domain name of the token contract. */
  name: string;
  /** EIP-712 domain version of the token contract. */
  version: string;
  symbol?: string;
  decimals?: number;
};

export type CasperMerchantConfig = {
  network: CasperNetwork;
  /** Where the money goes — the seller's Casper account hash. */
  payTo: string;
  /** Quoted price per request, in token base units. */
  price: bigint;
  /** Clamp floor — a misconfigured/manipulated quote can never go below. */
  minPrice?: bigint;
  /** Clamp ceiling — and never above. */
  maxPrice?: bigint;
  token: CasperTokenConfig;
  /**
   * Authorization validity window offered in the challenge (default 300s).
   * The facilitator refuses anything under 6s of remaining validity.
   */
  maxTimeoutSeconds?: number;
  resource?: string | CasperChallengeResource;
  description?: string;
};

export type CasperChallengeResource = {
  url: string;
  description?: string;
  mimeType?: string;
};

/** One `accepts[]` entry of a Casper 402 challenge (x402 v2 wire shape). */
export type CasperChallengeAccept = {
  scheme: "exact";
  network: CasperNetwork;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    symbol?: string;
    decimals?: string;
  };
};

export type CasperChallengeBody = {
  x402Version: 2;
  error: string;
  resource?: CasperChallengeResource;
  description?: string;
  accepts: CasperChallengeAccept[];
};

/** EIP-712 `TransferAuthorization` as it crosses the wire for Casper. */
export type CasperAuthorization = {
  /** Casper account hash of the payer. */
  from: string;
  /** Casper account hash of the payee. */
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 32-byte nonce, 64 hex chars. */
  nonce: string;
};

/** A `PAYMENT-SIGNATURE` / `X-PAYMENT` header decoded for the Casper rail. */
export type DecodedCasperPayment = {
  x402Version: 2;
  network: CasperNetwork;
  /** Casper public key of the signer (`01` ed25519 / `02` secp256k1 prefix). */
  publicKey: string;
  /** Payer account hash (`authorization.from`). */
  payer: string;
  amount: bigint;
  asset: string;
  signature: string;
  authorization: CasperAuthorization;
  accepted: Record<string, unknown>;
  resource?: CasperChallengeResource;
  raw: Record<string, unknown>;
};

export type CasperVerifyResult =
  | { ok: true; payer: string; amount: bigint; asset: string }
  | { ok: false; reason: string; message?: string };

export type CasperSettleResult = {
  /** Casper deploy/transaction hash of the settlement. */
  transaction: string;
  network: CasperNetwork;
  payer: string;
};

/* -------------------------------------------------------------------------- */
/* challenge                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp the quoted price into [minPrice, maxPrice]. */
export function casperEffectivePrice(cfg: CasperMerchantConfig): bigint {
  let p = cfg.price;
  if (cfg.minPrice != null && p < cfg.minPrice) p = cfg.minPrice;
  if (cfg.maxPrice != null && p > cfg.maxPrice) p = cfg.maxPrice;
  return p;
}

/** Build the 402 challenge body for a Casper resource. */
export function buildCasperChallenge(cfg: CasperMerchantConfig): CasperChallengeBody {
  const amount = casperEffectivePrice(cfg).toString();
  const timeout = cfg.maxTimeoutSeconds ?? 300;
  if (timeout < 6) {
    throw new Error("casper: maxTimeoutSeconds must be at least 6 (facilitator minimum)");
  }

  return {
    x402Version: 2,
    error: "payment required",
    ...(cfg.resource
      ? { resource: typeof cfg.resource === "string" ? { url: cfg.resource } : cfg.resource }
      : {}),
    ...(cfg.description ? { description: cfg.description } : {}),
    accepts: [
      {
        scheme: "exact",
        network: cfg.network,
        asset: cfg.token.asset,
        payTo: cfg.payTo,
        amount,
        maxTimeoutSeconds: timeout,
        extra: {
          name: cfg.token.name,
          version: cfg.token.version,
          ...(cfg.token.symbol ? { symbol: cfg.token.symbol } : {}),
          ...(cfg.token.decimals != null ? { decimals: String(cfg.token.decimals) } : {}),
        },
      },
    ],
  };
}

/** The `paymentRequirements` object the facilitator validates against. */
export function casperPaymentRequirements(cfg: CasperMerchantConfig): Record<string, unknown> {
  const [accept] = buildCasperChallenge(cfg).accepts;
  return {
    scheme: accept!.scheme,
    network: accept!.network,
    payTo: accept!.payTo,
    amount: accept!.amount,
    asset: accept!.asset,
    maxTimeoutSeconds: accept!.maxTimeoutSeconds,
    extra: accept!.extra,
  };
}

/* -------------------------------------------------------------------------- */
/* decode                                                                     */
/* -------------------------------------------------------------------------- */

function asAccountHash(v: unknown, field: string): string {
  if (typeof v !== "string" || !ACCOUNT_HASH.test(v)) {
    throw new Error(`casper payment: missing/invalid account hash in ${field}`);
  }
  return v;
}

function asNumeric(v: unknown, field: string): string {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string" || !/^\d+$/.test(s)) {
    throw new Error(`casper payment: missing/invalid integer in ${field}`);
  }
  return s;
}

function asHex(v: unknown, field: string, bytes?: number): string {
  if (typeof v !== "string" || !HEX.test(v) || (bytes != null && v.length !== bytes * 2)) {
    throw new Error(`casper payment: missing/invalid hex in ${field}`);
  }
  return v;
}

/**
 * Decode and validate a base64 x402 payment envelope for the Casper rail.
 *
 * Throws on malformed input; business rules (price, payTo, expiry) and the
 * signature live in `verifyCasperPayment` / the facilitator.
 */
export function decodeCasperPayment(header: string): DecodedCasperPayment {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error("casper payment: header is not base64-encoded JSON");
  }
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("casper payment: envelope is not an object");
  }

  const accepted = envelope.accepted as Record<string, unknown> | undefined;
  if (!accepted) throw new Error("casper payment: missing accepted");
  const network = accepted.network ?? envelope.network;
  if (typeof network !== "string" || !network.startsWith("casper:")) {
    throw new Error(`casper payment: accepted.network ${String(network)} is not a casper:* network`);
  }

  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) throw new Error("casper payment: missing payload");
  const a = payload.authorization as Record<string, unknown> | undefined;
  if (!a) throw new Error("casper payment: missing payload.authorization");

  const authorization: CasperAuthorization = {
    from: asAccountHash(a.from, "authorization.from"),
    to: asAccountHash(a.to, "authorization.to"),
    value: asNumeric(a.value, "authorization.value"),
    validAfter: asNumeric(a.validAfter, "authorization.validAfter"),
    validBefore: asNumeric(a.validBefore, "authorization.validBefore"),
    nonce: asHex(a.nonce, "authorization.nonce", 32),
  };

  const asset = accepted.asset;
  if (typeof asset !== "string" || !PACKAGE_HASH.test(asset)) {
    throw new Error("casper payment: missing/invalid accepted.asset (CEP-18 package hash)");
  }

  return {
    x402Version: 2,
    network,
    publicKey: asHex(payload.publicKey, "payload.publicKey"),
    payer: authorization.from,
    amount: BigInt(authorization.value),
    asset,
    signature: asHex(payload.signature, "payload.signature"),
    authorization,
    accepted,
    resource: envelope.resource as CasperChallengeResource | undefined,
    raw: envelope,
  };
}

/* -------------------------------------------------------------------------- */
/* facilitator client                                                         */
/* -------------------------------------------------------------------------- */

export type CasperFacilitatorOptions = {
  /** Defaults to `CASPER_FACILITATOR_URL`. */
  baseUrl?: string;
  /** Sent as the `authorization` header; CSPR.cloud requires an access token. */
  accessToken?: string;
  /** Injectable for tests / proxies. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
};

export type CasperFacilitator = {
  supported(): Promise<unknown>;
  verify(
    payment: DecodedCasperPayment,
    requirements: Record<string, unknown>,
  ): Promise<CasperVerifyResult>;
  settle(
    payment: DecodedCasperPayment,
    requirements: Record<string, unknown>,
  ): Promise<CasperSettleResult>;
};

/** Rebuild the `paymentPayload` the facilitator expects from a decoded header. */
export function casperPaymentPayload(p: DecodedCasperPayment): Record<string, unknown> {
  return {
    x402Version: 2,
    ...(p.resource ? { resource: p.resource } : {}),
    accepted: p.accepted,
    payload: {
      signature: p.signature,
      publicKey: p.publicKey,
      authorization: p.authorization,
    },
  };
}

/** HTTP client for an x402 facilitator that settles on Casper. */
export function createCasperFacilitator(opts: CasperFacilitatorOptions = {}): CasperFacilitator {
  const baseUrl = (opts.baseUrl ?? CASPER_FACILITATOR_URL).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    ...(opts.accessToken ? { authorization: opts.accessToken } : {}),
  };

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`casper facilitator: ${path} returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(
        `casper facilitator: ${path} failed with HTTP ${res.status}: ${
          (json.errorMessage as string) ?? (json.invalidMessage as string) ?? text
        }`,
      );
    }
    return json;
  }

  return {
    async supported() {
      const res = await doFetch(`${baseUrl}/supported`, { headers });
      return res.json();
    },

    async verify(payment, requirements) {
      const json = await post("/verify", {
        paymentPayload: casperPaymentPayload(payment),
        paymentRequirements: requirements,
      });
      if (json.isValid === true) {
        return {
          ok: true,
          payer: (json.payer as string) ?? payment.payer,
          amount: payment.amount,
          asset: payment.asset,
        };
      }
      return {
        ok: false,
        reason: (json.invalidReason as string) ?? "invalid_payload",
        ...(json.invalidMessage ? { message: json.invalidMessage as string } : {}),
      };
    },

    async settle(payment, requirements) {
      const json = await post("/settle", {
        paymentPayload: casperPaymentPayload(payment),
        paymentRequirements: requirements,
      });
      // /settle always answers HTTP 200; `success` carries the verdict.
      if (json.success !== true) {
        throw new Error(
          `casper settle failed: ${(json.errorReason as string) ?? "unknown"}${
            json.errorMessage ? `: ${json.errorMessage as string}` : ""
          }`,
        );
      }
      return {
        transaction: json.transaction as string,
        network: (json.network as string) ?? payment.network,
        payer: (json.payer as string) ?? payment.payer,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* local pre-checks                                                           */
/* -------------------------------------------------------------------------- */

export type CasperVerifyOptions = {
  /** Unix seconds "now" (tests); defaults to the wall clock. */
  now?: number;
};

/**
 * Cheap local business-rule checks — network, asset, payTo, price, expiry —
 * run before a payload is worth a facilitator round-trip. The facilitator
 * re-checks all of this plus the signature; this only avoids obvious traffic
 * and gives the merchant a precise local reason string.
 */
export function checkCasperPayment(
  p: DecodedCasperPayment,
  cfg: CasperMerchantConfig,
  opts: CasperVerifyOptions = {},
): CasperVerifyResult {
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));

  if (p.network !== cfg.network) {
    return {
      ok: false,
      reason: "network_mismatch",
      message: `payment is for ${p.network}, merchant is on ${cfg.network}`,
    };
  }
  if (p.asset.toLowerCase() !== cfg.token.asset.toLowerCase()) {
    return { ok: false, reason: "invalid_asset", message: `asset ${p.asset} is not the configured CEP-18 token` };
  }
  if (p.authorization.to.toLowerCase() !== cfg.payTo.toLowerCase()) {
    return {
      ok: false,
      reason: "pay_to_mismatch",
      message: `authorization pays ${p.authorization.to}, merchant is ${cfg.payTo}`,
    };
  }

  const price = casperEffectivePrice(cfg);
  if (p.amount < price) {
    return { ok: false, reason: "amount_mismatch", message: `amount ${p.amount} below the quoted price ${price}` };
  }
  if (cfg.maxPrice != null && p.amount > cfg.maxPrice) {
    return { ok: false, reason: "amount_mismatch", message: `amount ${p.amount} above maxPrice ${cfg.maxPrice}` };
  }

  if (BigInt(p.authorization.validAfter) > now) {
    return { ok: false, reason: "not_yet_valid", message: "authorization validAfter is in the future" };
  }
  const validBefore = BigInt(p.authorization.validBefore);
  if (validBefore <= now) {
    return { ok: false, reason: "payload_expired", message: "authorization validBefore is in the past" };
  }
  // The facilitator refuses to settle with under 6s of validity left.
  if (validBefore - now < 6n) {
    return { ok: false, reason: "insufficient_time", message: "less than 6 seconds of validity remain" };
  }

  return { ok: true, payer: p.payer, amount: p.amount, asset: p.asset };
}

/* -------------------------------------------------------------------------- */
/* merchant                                                                   */
/* -------------------------------------------------------------------------- */

export type CasperMerchantOptions = CasperMerchantConfig & {
  facilitator?: CasperFacilitator | CasperFacilitatorOptions;
  /**
   * Verify with the facilitator before settling (default false). Settlement
   * verifies too, so the extra round-trip only pays off when the merchant
   * wants to serve the resource first and settle asynchronously.
   */
  verifyBeforeSettle?: boolean;
};

export type CasperPaymentReceipt = CasperSettleResult & {
  amount: bigint;
  asset: string;
};

export type CasperHandleResult =
  | { status: 402; body: Record<string, unknown>; receipt?: undefined }
  | { status: 200; receipt: CasperPaymentReceipt };

function isFacilitator(v: unknown): v is CasperFacilitator {
  return typeof (v as CasperFacilitator | undefined)?.settle === "function";
}

/**
 * A framework-agnostic x402 merchant that takes CEP-18 payments on Casper.
 * Mirrors `createX402Merchant`'s surface (`challengeBody` / `requirePayment` /
 * `guard`) so a server can mount either rail the same way.
 */
export function createCasperX402Merchant(opts: CasperMerchantOptions) {
  const facilitator = isFacilitator(opts.facilitator)
    ? opts.facilitator
    : createCasperFacilitator(opts.facilitator ?? {});

  const challengeBody = () => buildCasperChallenge(opts) as unknown as Record<string, unknown>;
  const requirements = () => casperPaymentRequirements(opts);

  // In-process replay guard; the on-chain nonce is the durable source of truth.
  const seen = new Set<string>();

  async function requirePayment(paymentHeader: string | null): Promise<CasperHandleResult> {
    if (!paymentHeader) return { status: 402, body: challengeBody() };

    let decoded: DecodedCasperPayment;
    try {
      decoded = decodeCasperPayment(paymentHeader);
    } catch (e) {
      return { status: 402, body: { ...challengeBody(), error: `invalid payment: ${(e as Error).message}` } };
    }

    const local = checkCasperPayment(decoded, opts);
    if (!local.ok) {
      return {
        status: 402,
        body: { ...challengeBody(), error: `payment rejected: ${local.reason}`, invalidReason: local.reason },
      };
    }

    const nonceKey = `${decoded.payer}:${decoded.authorization.nonce}`;
    if (seen.has(nonceKey)) {
      return {
        status: 402,
        body: { ...challengeBody(), error: "payment rejected: replayed authorization" },
      };
    }
    seen.add(nonceKey);

    try {
      if (opts.verifyBeforeSettle) {
        const verdict = await facilitator.verify(decoded, requirements());
        if (!verdict.ok) {
          seen.delete(nonceKey);
          return {
            status: 402,
            body: {
              ...challengeBody(),
              error: `payment rejected: ${verdict.reason}`,
              invalidReason: verdict.reason,
            },
          };
        }
      }
      const settled = await facilitator.settle(decoded, requirements());
      return { status: 200, receipt: { ...settled, amount: decoded.amount, asset: decoded.asset } };
    } catch (e) {
      seen.delete(nonceKey); // let an honest retry through (e.g. a network hiccup)
      return { status: 402, body: { ...challengeBody(), error: `settlement failed: ${(e as Error).message}` } };
    }
  }

  /** Fetch-API sugar: returns null when paid (proceed), or a Response to send. */
  async function guard(
    request: Request,
  ): Promise<{ response: Response | null; receipt?: CasperPaymentReceipt }> {
    const result = await requirePayment(
      request.headers.get("PAYMENT-SIGNATURE") ?? request.headers.get("X-PAYMENT"),
    );
    if (result.status === 200) return { response: null, receipt: result.receipt };
    return {
      response: new Response(JSON.stringify(result.body), {
        status: 402,
        headers: { "content-type": "application/json" },
      }),
    };
  }

  return { challengeBody, requirePayment, guard, facilitator };
}
