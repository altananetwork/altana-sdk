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
  /** Echoed into the X-PAYMENT so it matches the challenge (real B402 = 2). */
  x402Version?: number;
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

/** The signed X-PAYMENT payload (before base64). */
export type X402PaymentPayload = {
  x402Version: number;
  scheme: string;
  network: string;
  /**
   * The chosen requirement, echoed back. Real Binance B402 needs this to route
   * the payment to the right config — without it the facilitator returns
   * "Unsupported x402 payload". Mirrors the documented `paymentPayload.accepted`.
   */
  accepted?: X402Requirement;
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
  /** permit2-exact witness `validAfter`; defaults to 0. */
  permit2ValidAfter?: bigint;
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

/**
 * Resolve which on-chain rail a requirement uses. Real B402 puts it in
 * `extra.assetTransferMethod`; the legacy shape carried it in `scheme`.
 * Returns "permit2" or "eip3009".
 */
function resolveRail(req: X402Requirement): "permit2" | "eip3009" {
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

export async function signX402Payment(
  session: Session,
  req: X402Requirement,
  opts: SignX402Options = {},
): Promise<{ header: string; payload: X402PaymentPayload }> {
  const chainId = networkToChainId(req.network);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const timeout = req.maxTimeoutSeconds ?? 3600;

  const amountStr = req.maxAmountRequired ?? req.amount;
  if (amountStr == null) {
    throw new Error("x402: requirement is missing an amount (maxAmountRequired/amount).");
  }
  const amount = BigInt(amountStr);

  // Echo the challenge's version/scheme/network so the X-PAYMENT matches it
  // (real B402: x402Version 2, scheme "exact", network "eip155:56").
  const version = req.x402Version ?? 1;
  const rail = resolveRail(req);

  let inner: Record<string, unknown>;

  if (rail === "permit2") {
    const spender = req.extra?.spenderAddress ?? req.extra?.spender;
    if (!spender) {
      throw new Error(
        "x402 permit2-exact: requirement is missing extra.spenderAddress (the facilitator settler bound as the Permit2 spender).",
      );
    }
    const nonce = opts.permit2Nonce ?? BigInt(randomHex32());
    const deadline = BigInt(now + timeout);
    // B402 permit2-exact routes through the x402ExactPermit2Proxy, which
    // verifies a `permitWitnessTransferFrom` binding the recipient (payTo).
    // The legacy plain "permit2" scheme signs a direct PermitTransferFrom.
    const isWitness = req.extra?.assetTransferMethod === "permit2-exact";
    if (isWitness) {
      const validAfter = opts.permit2ValidAfter ?? 0n;
      const signature = await signOrderTypedData(
        session,
        buildPermit2WitnessTypedData({
          chainId,
          token: req.asset,
          amount,
          spender,
          nonce,
          deadline,
          to: req.payTo,
          validAfter,
        }) as any,
      );
      inner = {
        signature,
        from: session.walletAddress,
        permit: {
          permitted: { token: req.asset, amount: amount.toString() },
          spender,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
          witness: { to: req.payTo, validAfter: validAfter.toString() },
        },
      };
    } else {
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
      inner = {
        signature,
        // The token owner (payer) — the facilitator needs it for
        // Permit2.permitTransferFrom(owner, …).
        from: session.walletAddress,
        permit: {
          permitted: { token: req.asset, amount: amount.toString() },
          spender,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      };
    }
  } else {
    const name = req.extra?.name;
    const version712 = req.extra?.version;
    if (!name || !version712) {
      throw new Error(
        "x402 eip3009: requirement is missing extra.name/version (the token's EIP-712 domain).",
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
        version: version712,
        from: session.walletAddress,
        to: req.payTo,
        value: amount,
        validAfter: 0n,
        validBefore,
        nonce,
      }) as any,
    );
    inner = {
      signature,
      authorization: {
        from: session.walletAddress,
        to: req.payTo,
        value: amount.toString(),
        validAfter: "0",
        validBefore: validBefore.toString(),
        nonce,
      },
    };
  }

  // Echo the chosen requirement as `accepted` so the facilitator can match it
  // to its config. Strip our transport-only x402Version so `accepted` mirrors
  // the 402's requirement verbatim.
  const { x402Version: _txVersion, ...accepted } = req;

  const payload: X402PaymentPayload = {
    x402Version: version,
    scheme: req.scheme,
    network: req.network,
    accepted,
    payload: inner,
  };
  return { header: encodeXPaymentHeader(payload), payload };
}

/** Preference knobs for choosing among a 402's payment options. */
export type FetchWithX402Options = {
  /** Only pay options on this chain (e.g. 56 for BNB) when any match. */
  chainId?: number;
  /**
   * Preferred rail when a chain offers several. Defaults to "permit2" —
   * permit2-exact validates a smart-account signer on-chain via ERC-1271 for
   * ANY token, whereas eip3009 only works for ERC-1271-aware tokens.
   */
  preferRail?: "permit2" | "eip3009";
};

/** Can this SDK build+sign a payment for the requirement? */
function isPayable(req: X402Requirement): boolean {
  try {
    networkToChainId(req.network);
    resolveRail(req);
    return true;
  } catch {
    return false;
  }
}

/**
 * Choose which 402 option to pay. Filters to payable options, prefers the
 * requested chain, then the reliable rail (permit2-exact for smart wallets).
 */
export function selectX402Requirement(
  options: X402Requirement[],
  opts: FetchWithX402Options = {},
): X402Requirement | undefined {
  const payable = options.filter(isPayable);
  if (payable.length === 0) return undefined;

  let pool = payable;
  if (opts.chainId != null) {
    const onChain = payable.filter((o) => networkToChainId(o.network) === opts.chainId);
    if (onChain.length > 0) pool = onChain;
  }
  const preferRail = opts.preferRail ?? "permit2";
  const preferred = pool.filter((o) => resolveRail(o) === preferRail);
  return (preferred[0] ?? pool[0]);
}

/**
 * fetch() that transparently pays x402 challenges. On a 402, parses the
 * requirements, picks a payable option (see selectX402Requirement), signs it
 * with the session key, and retries with the `X-PAYMENT` header. Non-402
 * responses pass through unchanged.
 */
export async function fetchWithX402(
  session: Session,
  url: string,
  init?: RequestInit,
  x402Opts?: FetchWithX402Options,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 402) return res;

  // Parse the payment requirements. Standard x402 / B402 put options under
  // `accepts`; tolerate a bare single requirement too.
  const body: any = await res.json();
  const rawOptions: X402Requirement[] = Array.isArray(body?.accepts)
    ? body.accepts
    : body?.scheme
      ? [body]
      : [];
  // The version lives at the top of the 402 body; carry it onto each option so
  // the X-PAYMENT echoes it (real B402 = 2).
  const options = rawOptions.map((o) => ({
    x402Version: o.x402Version ?? body?.x402Version,
    ...o,
  }));

  const req = selectX402Requirement(options, x402Opts);
  if (!req) {
    throw new Error(
      `x402: 402 response offered no payable option (saw: ${options
        .map((o) => `${o.scheme}/${o.extra?.assetTransferMethod ?? "?"}@${o.network}`)
        .join(", ") || "none"}).`,
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

/** Inputs for a Permit2 `PermitWitnessTransferFrom` (B402 permit2-exact). */
export type Permit2WitnessInput = Permit2PaymentInput & {
  /**
   * Witness recipient — the merchant `payTo`, bound into the signature so the
   * settler can't redirect funds. Verified by the x402ExactPermit2Proxy.
   */
  to: Address;
  /** Witness `validAfter` (B402 permit2-exact uses 0). */
  validAfter: bigint;
};

/**
 * Build the EIP-712 typed data for a Permit2 `PermitWitnessTransferFrom` with
 * the B402 `Witness(address to,uint256 validAfter)` — the digest the
 * x402ExactPermit2Proxy (`spender`) actually verifies. The witness type string
 * is taken verbatim from that proxy's on-chain bytecode.
 */
export function buildPermit2WitnessTypedData(
  input: Permit2WitnessInput,
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
      Witness: [
        { name: "to", type: "address" },
        { name: "validAfter", type: "uint256" },
      ],
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: input.token, amount: input.amount },
      spender: input.spender,
      nonce: input.nonce,
      deadline: input.deadline,
      witness: { to: input.to, validAfter: input.validAfter },
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
