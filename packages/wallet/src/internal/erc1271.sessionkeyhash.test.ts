import { test, expect } from "bun:test";
import * as Key from "porto/viem/Key";
import type { Address } from "viem";
import { createPrivateKeySigner } from "./signer.js";
import {
  createHeadlessPasskey,
  passkeyToPortoKey,
  type PasskeySigner,
} from "./passkey.js";
import type { Signer } from "./signer.js";
import type { Session } from "./sessions.js";
import { sessionKeyHash } from "./erc1271.js";

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

test("sessionKeyHash (secp256k1) matches Porto Key.hash", () => {
  const signer = createPrivateKeySigner();
  const portoKey = Key.fromSecp256k1({
    privateKey: (signer as any)._privateKey,
    role: "session",
  });
  expect(sessionKeyHash(makeSession(signer))).toBe(Key.hash(portoKey));
});

test("sessionKeyHash (passkey) matches Porto Key.hash", () => {
  const signer: PasskeySigner = createHeadlessPasskey();
  const portoKey = passkeyToPortoKey(signer, { role: "session" });
  expect(sessionKeyHash(makeSession(signer))).toBe(Key.hash(portoKey));
});
