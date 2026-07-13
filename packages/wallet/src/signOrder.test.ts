import { test, expect } from "bun:test";
import {
  hashTypedData,
  recoverAddress,
  size,
  sliceHex,
  type Address,
  type Hex,
} from "viem";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import { createHeadlessPasskey } from "./internal/passkey.js";
import {
  erc1271Digest,
  sessionKeyHash,
} from "./internal/erc1271.js";
import type { Session } from "./internal/sessions.js";
import { signOrder, signOrderTypedData } from "./signOrder.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const APP_DIGEST: Hex =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 0,
  };
}

test("signOrder (secp256k1) wraps inner(65) || keyHash(32) || prehash(0)", async () => {
  const session = makeSession(createPrivateKeySigner());
  const wrapped = await signOrder(session, APP_DIGEST);

  // 65 (r,s,v) + 32 (keyHash) + 1 (prehash) = 98 bytes. Length > 65 keeps the
  // account off its bare-EOA shortcut (IthacaAccount.sol:501).
  expect(size(wrapped)).toBe(98);

  const inner = sliceHex(wrapped, 0, 65);
  const keyHash = sliceHex(wrapped, 65, 97);
  const prehash = sliceHex(wrapped, 97, 98);

  expect(keyHash).toBe(sessionKeyHash(session));
  expect(prehash).toBe("0x00");

  // The inner secp256k1 sig must be over the account's NESTED digest, not the
  // raw app digest — recover the signer from it and check identity.
  const final = erc1271Digest(WALLET, APP_DIGEST);
  const recovered = await recoverAddress({ hash: final, signature: inner });
  expect(recovered.toLowerCase()).toBe(session.signer.address.toLowerCase());
});

test("signOrder (passkey) wraps a WebAuthnP256 inner sig with the right keyHash", async () => {
  const session = makeSession(createHeadlessPasskey());
  const wrapped = await signOrder(session, APP_DIGEST);

  // trailing prehash byte is 0 for webauthn; keyHash sits before it.
  const keyHash = sliceHex(wrapped, size(wrapped) - 33, size(wrapped) - 1);
  const prehash = sliceHex(wrapped, size(wrapped) - 1, size(wrapped));
  expect(keyHash).toBe(sessionKeyHash(session));
  expect(prehash).toBe("0x00");
  // webauthn inner sig is a large abi-encoded WebAuthnAuth struct, so the whole
  // envelope is well beyond the 98-byte secp256k1 case.
  expect(size(wrapped)).toBeGreaterThan(98);
});

test("signOrderTypedData equals signOrder over the typed-data hash", async () => {
  const session = makeSession(createPrivateKeySigner());
  const typedData = {
    domain: { name: "X", chainId: 56, verifyingContract: WALLET },
    types: { Order: [{ name: "amount", type: "uint256" }] },
    primaryType: "Order",
    message: { amount: 123n },
  } as const;

  const viaTyped = await signOrderTypedData(session, typedData as any);
  const viaHash = await signOrder(session, hashTypedData(typedData as any));
  expect(viaTyped).toBe(viaHash);
});
