import { hashTypedData, type Hex, type TypedDataDomain, type TypedData } from "viem";
import type { Session } from "./internal/sessions.js";
import { signErc1271 } from "./internal/erc1271.js";

/**
 * Sign an app digest for the session's wallet, producing the wrapped signature
 * IthacaAccount's `isValidSignature` accepts.
 *
 * Offline and chain-independent (the account's ERC-1271 domain carries no
 * chainId). The `appDigest` is the protocol's own EIP-712 digest — e.g. a DEX
 * order hash, a Permit2 PermitTransferFrom hash, or an EIP-3009
 * TransferWithAuthorization hash. Hand the returned bytes to the protocol as the
 * signature; when it later calls `wallet.isValidSignature(appDigest, sig)` the
 * account re-derives the nested digest and validates.
 *
 * Requires `approveSignatureChecker` to have authorized, for this session, the
 * contract that will call `isValidSignature` (else validation returns invalid).
 */
export function signOrder(session: Session, appDigest: Hex): Promise<Hex> {
  return signErc1271(session, appDigest);
}

/**
 * Same as `signOrder`, but takes an EIP-712 typed-data object and computes its
 * digest for you. Convenient when the protocol hands you the structured order
 * rather than a precomputed hash.
 */
export function signOrderTypedData(
  session: Session,
  typedData: {
    domain?: TypedDataDomain;
    types: TypedData;
    primaryType: string;
    message: Record<string, unknown>;
  },
): Promise<Hex> {
  return signOrder(session, hashTypedData(typedData as any));
}
