/**
 * ERC-1271 signing internals for the Altana account (IthacaAccount).
 *
 * The account validates an app signature (Permit2, EIP-3009, DEX order, …) via
 * `isValidSignature(appDigest, signature)`. It does NOT verify against the raw
 * app digest — it re-wraps it in a nested EIP-712 envelope keyed to the account
 * address, then checks the wrapped digest against a stored key. This module
 * reproduces that nesting off-chain and produces the wrapped signature the
 * account expects.
 *
 * See IthacaAccount.sol:262-283 (isValidSignature) and :491-565
 * (unwrapAndValidateSignature).
 */

import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  padHex,
  type Address,
  type Hex,
} from "viem";
import * as Key from "porto/viem/Key";
import type { Session } from "./sessions.js";
import { isPasskeySigner, passkeyToPortoKey } from "./passkey.js";
import { hasRawPrivateKey } from "./signer.js";

/**
 * Compute the digest the account actually verifies for a given app digest.
 *
 * final = keccak256(0x1901 || domainSeparator(wallet) || structHash)
 *   structHash      = keccak256(abi.encode(SIGN_TYPEHASH, appDigest))
 *   SIGN_TYPEHASH   = keccak256("ERC1271Sign(bytes32 digest)")
 *   domainSeparator = keccak256(abi.encode(
 *                       keccak256("EIP712Domain(address verifyingContract)"),
 *                       wallet))
 *
 * The account's EIP-712 domain is intentionally stripped to `verifyingContract`
 * only (no name/version/chainId) — see IthacaAccount.sol:234-252.
 */
export function erc1271Digest(wallet: Address, appDigest: Hex): Hex {
  // viem's hashTypedData builds the domain from exactly the fields present, so
  // passing only `verifyingContract` reproduces the account's stripped domain
  // (typehash keccak256("EIP712Domain(address verifyingContract)")), and the
  // ERC1271Sign struct hash is keccak256(abi.encode(SIGN_TYPEHASH, appDigest)).
  return hashTypedData({
    domain: { verifyingContract: wallet },
    types: { ERC1271Sign: [{ name: "digest", type: "bytes32" }] },
    primaryType: "ERC1271Sign",
    message: { digest: appDigest },
  });
}

/**
 * The keyHash IthacaAccount stores for a Secp256k1 key:
 *   keccak256(abi.encode(uint256(keyType=2), keccak256(abi.encode(address))))
 * where the stored publicKey is the 20-byte address, left-padded to 32 bytes.
 * (KeyType enum: P256=0, WebAuthnP256=1, Secp256k1=2, External=3.)
 */
export function computeAccountSecp256k1KeyHash(address: Address): Hex {
  const encodedPubKey = padHex(address, { size: 32 });
  const publicKeyHash = keccak256(encodedPubKey);
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [2n, publicKeyHash],
    ),
  );
}

/**
 * keyHash of a session key as stored on-chain by IthacaAccount. Branches on the
 * key's curve: secp256k1 sessions hash the address; passkey (WebAuthnP256)
 * sessions hash the flat P256 public key via Porto's Key.hash (keyType 1).
 */
export function sessionKeyHash(session: Session): Hex {
  if (isPasskeySigner(session.signer)) {
    return Key.hash({
      publicKey: session.signer.credential.publicKey,
      type: "webauthn-p256",
    });
  }
  return computeAccountSecp256k1KeyHash(session.signer.address);
}

/**
 * Produce the wrapped ERC-1271 signature over `appDigest` for the session's
 * wallet. Computes the account's nested digest, then signs+wraps it with the
 * session key via Porto (`address: null` = sign our own digest raw; `wrap`
 * defaults true → `innerSig || keyHash || prehash`). Handles both secp256k1 and
 * passkey (WebAuthnP256) session keys.
 */
export function signErc1271(session: Session, appDigest: Hex): Promise<Hex> {
  const final = erc1271Digest(session.walletAddress, appDigest);
  const signer = session.signer;

  let portoKey: Key.Key;
  if (isPasskeySigner(signer)) {
    portoKey = passkeyToPortoKey(signer, { role: "session" });
  } else if (hasRawPrivateKey(signer)) {
    portoKey = Key.fromSecp256k1({
      privateKey: signer._privateKey,
      role: "session",
    });
  } else {
    throw new Error(
      `signOrder: unsupported session signer type "${signer.type}". ` +
        "Sessions must be secp256k1 (privateKey) or passkey.",
    );
  }

  return Key.sign(portoKey, { address: null, payload: final });
}
