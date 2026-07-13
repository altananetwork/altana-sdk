/**
 * x402 payment support.
 *
 * x402 is an HTTP 402 flow: a server responds 402 with payment requirements, the
 * client signs an authorization, base64-encodes it into an `X-PAYMENT` header,
 * and retries. A facilitator submits the authorization on-chain.
 *
 * From an Altana smart-account session key, the authorization is validated
 * on-chain via ERC-1271 `isValidSignature`, so both schemes here reuse the
 * account's nested signing (signOrderTypedData):
 *
 *  - **Permit2** (Altana extension, the reliable rail — works with any token
 *    approved to Permit2): sign a Permit2 `PermitTransferFrom`; checker = Permit2.
 *  - **exact / EIP-3009** (the standard x402 wire): sign a token
 *    `TransferWithAuthorization`; checker = the token. Only works with tokens
 *    whose EIP-3009 is ERC-1271-aware (Circle FiatTokenV2_2).
 *
 * `approveSignatureChecker` must have authorized the corresponding checker for
 * the session first (see approveSignatureChecker / approveTokenForPermit2).
 */

import { bytesToHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import * as Base64 from "ox/Base64";
import type { Session } from "./internal/sessions.js";
import { signOrderTypedData } from "./signOrder.js";

/** Canonical Permit2 — identical on every chain. */
export const PERMIT2_ADDRESS: Address =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** Inputs for a Permit2 `PermitTransferFrom` authorization. */
export type Permit2PaymentInput = {
  chainId: number;
  token: Address;
  amount: bigint;
  /** The facilitator that will call `permitTransferFrom` (bound as `spender`). */
  spender: Address;
  nonce: bigint;
  deadline: bigint;
};

/** Inputs for an EIP-3009 `TransferWithAuthorization`. */
export type Eip3009PaymentInput = {
  chainId: number;
  /** The token contract (EIP-712 verifyingContract). */
  token: Address;
  /** Token EIP-712 domain name/version (from the 402 `extra`). */
  name: string;
  version: string;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** 32-byte random authorization nonce. */
  nonce: Hex;
};

/**
 * A single payment option from an HTTP 402 response body (`accepts[i]`).
 * `scheme` is "exact" (standard x402, EIP-3009) or "permit2" (Altana extension).
 */
export type X402Requirement = {
  scheme: string;
  network: string;
  asset: Address;
  /** Amount in atomic token units, as a decimal string. */
  maxAmountRequired: string;
  payTo: Address;
  maxTimeoutSeconds?: number;
  extra?: {
    /** EIP-3009 token EIP-712 domain. */
    name?: string;
    version?: string;
    /** Permit2: the facilitator settler bound as `spender`. */
    spender?: Address;
  };
};

/** The signed X-PAYMENT payload (before base64). */
export type X402PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
};

/** Overrides for the otherwise time/random-derived fields (tests, replay control). */
export type SignX402Options = {
  /** Unix seconds "now"; defaults to Date.now()/1000. */
  now?: number;
  /** EIP-3009 32-byte authorization nonce; defaults to random. */
  eip3009Nonce?: Hex;
  /** Permit2 nonce; defaults to a random uint256. */
  permit2Nonce?: bigint;
};

/** Map an x402 network name to a chainId. */
export function networkToChainId(network: string): number {
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
    default:
      throw new Error(`x402: unsupported network "${network}".`);
  }
}

/** base64 of the JSON payload — the `X-PAYMENT` header value. */
export function encodeXPaymentHeader(payload: X402PaymentPayload): string {
  return Base64.fromString(JSON.stringify(payload));
}

/**
 * Build and sign the X-PAYMENT payload for a 402 requirement using the session
 * key. Dispatches on `req.scheme`: "exact" → EIP-3009; "permit2" → Permit2.
 * Requires the corresponding checker to be approved for the session on-chain.
 */
function randomHex32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function signX402Payment(
  session: Session,
  req: X402Requirement,
  opts: SignX402Options = {},
): Promise<{ header: string; payload: X402PaymentPayload }> {
  const chainId = networkToChainId(req.network);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const timeout = req.maxTimeoutSeconds ?? 3600;
  const amount = BigInt(req.maxAmountRequired);

  let payload: X402PaymentPayload;

  if (req.scheme === "permit2") {
    const spender = req.extra?.spender;
    if (!spender) {
      throw new Error(
        'x402 permit2: requirement is missing extra.spender (the facilitator settler address bound as the Permit2 "spender").',
      );
    }
    const nonce = opts.permit2Nonce ?? BigInt(randomHex32());
    const deadline = BigInt(now + timeout);
    const signature = await signOrderTypedData(
      session,
      buildPermit2TypedData({
        chainId,
        token: req.asset,
        amount,
        spender,
        nonce,
        deadline,
      }) as any,
    );
    payload = {
      x402Version: 1,
      scheme: "permit2",
      network: req.network,
      payload: {
        signature,
        permit: {
          permitted: { token: req.asset, amount: amount.toString() },
          spender,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      },
    };
  } else if (req.scheme === "exact") {
    const name = req.extra?.name;
    const version = req.extra?.version;
    if (!name || !version) {
      throw new Error(
        "x402 exact/EIP-3009: requirement is missing extra.name/version (the token's EIP-712 domain).",
      );
    }
    const validBefore = BigInt(now + timeout);
    const nonce = opts.eip3009Nonce ?? randomHex32();
    const signature = await signOrderTypedData(
      session,
      buildEip3009TypedData({
        chainId,
        token: req.asset,
        name,
        version,
        from: session.walletAddress,
        to: req.payTo,
        value: amount,
        validAfter: 0n,
        validBefore,
        nonce,
      }) as any,
    );
    payload = {
      x402Version: 1,
      scheme: "exact",
      network: req.network,
      payload: {
        signature,
        authorization: {
          from: session.walletAddress,
          to: req.payTo,
          value: amount.toString(),
          validAfter: "0",
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    };
  } else {
    throw new Error(
      `x402: unsupported scheme "${req.scheme}" (expected "exact" or "permit2").`,
    );
  }

  return { header: encodeXPaymentHeader(payload), payload };
}

/**
 * fetch() that transparently pays x402 challenges. On a 402, parses the
 * requirements, signs a payment with the session key, and retries with the
 * `X-PAYMENT` header. Non-402 responses pass through unchanged.
 */
const SUPPORTED_SCHEMES = new Set(["exact", "permit2"]);

export async function fetchWithX402(
  session: Session,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 402) return res;

  // Parse the payment requirements. Standard x402 puts options under `accepts`;
  // tolerate a bare single requirement too.
  const body: any = await res.json();
  const options: X402Requirement[] = Array.isArray(body?.accepts)
    ? body.accepts
    : body?.scheme
      ? [body]
      : [];
  const req = options.find((o) => SUPPORTED_SCHEMES.has(o.scheme));
  if (!req) {
    throw new Error(
      `x402: 402 response offered no supported scheme (saw: ${options
        .map((o) => o.scheme)
        .join(", ") || "none"}; supported: exact, permit2).`,
    );
  }

  const { header } = await signX402Payment(session, req);
  const headers = new Headers(init?.headers);
  headers.set("X-PAYMENT", header);
  return fetch(url, { ...init, headers });
}

/** Build the EIP-712 typed data for a Permit2 `PermitTransferFrom`. */
export function buildPermit2TypedData(
  input: Permit2PaymentInput,
): TypedDataDefinition {
  return {
    domain: {
      name: "Permit2",
      chainId: input.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    },
    types: {
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: input.token, amount: input.amount },
      spender: input.spender,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  };
}

/** Build the EIP-712 typed data for an EIP-3009 `TransferWithAuthorization`. */
export function buildEip3009TypedData(
  input: Eip3009PaymentInput,
): TypedDataDefinition {
  return {
    domain: {
      name: input.name,
      version: input.version,
      chainId: input.chainId,
      verifyingContract: input.token,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: input.from,
      to: input.to,
      value: input.value,
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    },
  };
}
