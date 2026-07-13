import { test, expect } from "bun:test";
import * as Key from "porto/viem/Key";
import type { Address } from "viem";
import { createPrivateKeySigner, type Signer } from "./signer.js";
import { createHeadlessPasskey } from "./passkey.js";
import { sessionKeyHash } from "./erc1271.js";
import { keyDescriptorFromSigner, toPortoKey } from "./relay.js";
import type { Session } from "./sessions.js";

const WALLET: Address = "0x1111111111111111111111111111111111111111";

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 0,
  };
}

// The invariant that keeps signing from silently failing: the keyHash the
// authorize path registers on-chain (Porto Key from the descriptor) must equal
// the keyHash signOrder signs under (sessionKeyHash).
test("secp256k1 session descriptor registers the keyHash signOrder signs under", () => {
  const signer = createPrivateKeySigner();
  const desc = keyDescriptorFromSigner(signer, { role: "session" });
  expect(desc.type).toBe("secp256k1");
  expect(Key.hash(toPortoKey(desc))).toBe(sessionKeyHash(makeSession(signer)));
});

test("passkey session descriptor registers the keyHash signOrder signs under", () => {
  const signer = createHeadlessPasskey();
  const desc = keyDescriptorFromSigner(signer, { role: "session" });
  expect(desc.type).toBe("webauthn-p256");
  expect(Key.hash(toPortoKey(desc))).toBe(sessionKeyHash(makeSession(signer)));
});
