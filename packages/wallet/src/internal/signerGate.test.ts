import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { registerAccount, submitCalls } from "./relay.js";
import type { Signer } from "./signer.js";

// A hand-rolled signer that is neither a PrivateKeySigner nor a
// PasskeySigner. `type` needs the cast on purpose: since #56, "injected"
// is no longer a SignerType member, so only untyped/hand-rolled objects
// can carry it — and they must still get the helpful runtime message.
const fakeSigner = (type: string): Signer => ({
  type: type as Signer["type"],
  address: "0x0000000000000000000000000000000000000001" as Address,
  publicKey: "0x04" as Hex,
  signDigest: async () => "0x" as Hex,
});

const feeToken = "0x0000000000000000000000000000000000000000" as Address;

describe("unsupported signer gate", () => {
  test("registerAccount rejects an injected signer with the MetaMask guidance", async () => {
    await expect(registerAccount(null as never, fakeSigner("injected"))).rejects.toThrow(
      /Injected wallet signers \(e\.g\. MetaMask\) need to create a wallet/,
    );
  });

  test("registerAccount rejects an unknown signer type with the generic message", async () => {
    await expect(registerAccount(null as never, fakeSigner("hardware"))).rejects.toThrow(
      /Got a signer with type "hardware"/,
    );
  });

  test("submitCalls rejects an injected signer before touching the relay", async () => {
    // role: "session" skips the admin-only KeyStore read, so the gate is
    // reached with zero network I/O — the nulled-out client proves it.
    await expect(
      submitCalls(null as never, fakeSigner("injected").address, fakeSigner("injected"), [], {
        feeToken,
        submittingKey: { type: "secp256k1", publicKey: "0x04", role: "session" },
        network: null as never,
      }),
    ).rejects.toThrow(/Injected wallet signers \(e\.g\. MetaMask\) need to sign a transaction/);
  });

  test("both messages name every supported constructor", async () => {
    for (const type of ["injected", "hardware"]) {
      const err = await registerAccount(null as never, fakeSigner(type)).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(err).toContain("signerFromPrivateKey(privateKey)");
      expect(err).toContain("createPrivateKeySigner()");
      expect(err).toContain("createPasskey({ name })");
      expect(err).toContain("createHeadlessPasskey()");
    }
  });
});
