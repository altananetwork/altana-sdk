/**
 * WebAuthn function injection (issue #65): runtimes without the browser
 * WebAuthn API — React Native and friends — supply createFn/getFn from a
 * native passkey library, and the SDK forwards them into porto everywhere
 * WebAuthn is touched.
 *
 * These tests use the same patterns porto's and ox's own suites use for
 * non-browser environments (their docs: "useful for environments that do
 * not support the WebAuthn API natively (i.e. React Native or testing
 * environments)"):
 *  - createFn: a fixture credential whose response exposes getPublicKey()
 *    returning SPKI DER — driven through porto/ox's REAL parsing.
 *  - getFn: a ~35-line software authenticator — real P256 signature over
 *    authenticatorData || sha256(clientDataJSON), DER-encoded — driven
 *    through porto's REAL Key.sign envelope wrapping.
 * No module mocks anywhere.
 */
import { describe, expect, test } from "bun:test";
import * as P256 from "ox/P256";
import * as PublicKey from "ox/PublicKey";
import * as Signature from "ox/Signature";
import * as WebAuthnP256 from "ox/WebAuthnP256";
import * as Base64 from "ox/Base64";
import { hexToBytes, sha256, type Address, type Hex } from "viem";
import { createPasskey, createHeadlessPasskey, passkeyToPortoKey } from "./passkey.js";
import { signPreparedCalls } from "./relay.js";
import { signErc1271 } from "./erc1271.js";
import { recoverFromPasskey } from "../recoverFromPasskey.js";
import { BNB_TESTNET } from "../config.js";
import type { Session } from "./sessions.js";

const RP_ID = "dolphin.example";
const WALLET: Address = "0x1111111111111111111111111111111111111111";

/** A P256 keypair playing the role of the device's secure-enclave key. */
function makeAuthenticatorKey() {
  const privateKey = P256.randomPrivateKey();
  const publicKey = P256.getPublicKey({ privateKey });
  // SPKI DER = fixed P-256 prefix + uncompressed point (0x04 || x || y).
  const point = PublicKey.toHex(publicKey, { includePrefix: true });
  const spki = hexToBytes(`0x3059301306072a8648ce3d020106082a8648ce3d030107034200${point.slice(2)}` as Hex);
  return { privateKey, publicKey, spki };
}

/** porto's own Key.test.ts fixture shape: id + response.getPublicKey(). */
function makeCreateFn(spki: Uint8Array, calls: unknown[]) {
  return ((options?: unknown) => {
    calls.push(options);
    return Promise.resolve({
      id: Base64.fromBytes(new Uint8Array([1, 2, 3, 4]), { url: true, pad: false }),
      response: { getPublicKey: () => spki },
    } as never);
  }) as never;
}

/** Software authenticator: real assertion signature, no navigator. */
function makeGetFn(privateKey: Hex, calls: unknown[]) {
  return ((options?: any) => {
    calls.push(options);
    const challenge: Uint8Array = options?.publicKey?.challenge ?? new Uint8Array(32);
    const rpId: string = options?.publicKey?.rpId ?? RP_ID;
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: Base64.fromBytes(challenge, { url: true, pad: false }),
        origin: `https://${rpId}`,
        crossOrigin: false,
      }),
    );
    const authenticatorData = hexToBytes(WebAuthnP256.getAuthenticatorData({ rpId }));
    const payload = new Uint8Array([...authenticatorData, ...hexToBytes(sha256(clientDataJSON))]);
    const signature = Signature.toDerBytes(P256.sign({ payload, privateKey, hash: true }));
    return Promise.resolve({
      id: options?.publicKey?.allowCredentials?.[0]?.id
        ? Base64.fromBytes(new Uint8Array(options.publicKey.allowCredentials[0].id), { url: true, pad: false })
        : Base64.fromBytes(new Uint8Array([1, 2, 3, 4]), { url: true, pad: false }),
      response: {
        clientDataJSON: clientDataJSON.buffer,
        authenticatorData: authenticatorData.buffer,
        signature: signature.buffer,
        // porto hard-requires userHandle; native passkey libraries return it.
        userHandle: hexToBytes(WALLET).buffer,
      },
    } as never);
  }) as never;
}

describe("createPasskey with webAuthn.createFn", () => {
  test("creates a signer through porto/ox's real credential parsing — no navigator", async () => {
    const auth = makeAuthenticatorKey();
    const calls: unknown[] = [];
    const signer = await createPasskey({
      name: "Dolphin Agent",
      rpId: RP_ID,
      webAuthn: { createFn: makeCreateFn(auth.spki, calls) },
    });
    expect(calls).toHaveLength(1);
    expect(signer.type).toBe("passkey");
    expect(signer.credential.kind).toBe("webauthn");
    // Flat x||y — parsed out of the SPKI we supplied, via real ox parsing.
    expect(signer.credential.publicKey.toLowerCase()).toBe(
      ("0x" + PublicKey.toHex(auth.publicKey, { includePrefix: true }).slice(4)).toLowerCase(),
    );
    expect((signer.credential as { rpId?: string }).rpId).toBe(RP_ID);
    expect(signer.webAuthn?.createFn).toBeDefined();
  });

  test("outside a browser, rpId is required with createFn", async () => {
    const auth = makeAuthenticatorKey();
    await expect(
      createPasskey({ name: "x", webAuthn: { createFn: makeCreateFn(auth.spki, []) } }),
    ).rejects.toThrow(/rpId is required/);
  });

  test("without createFn and without a browser, the guard names the options", async () => {
    await expect(createPasskey({ name: "x" })).rejects.toThrow(/webAuthn: \{ createFn, getFn \}/);
  });
});

describe("signing with webAuthn.getFn", () => {
  async function makeSigner() {
    const auth = makeAuthenticatorKey();
    const getCalls: unknown[] = [];
    const signer = await createPasskey({
      name: "Dolphin Agent",
      rpId: RP_ID,
      webAuthn: { createFn: makeCreateFn(auth.spki, []), getFn: makeGetFn(auth.privateKey, getCalls) },
    });
    return { signer, getCalls };
  }

  test("signErc1271 routes the assertion through the injected getFn", async () => {
    const { signer, getCalls } = await makeSigner();
    const session: Session = {
      walletAddress: WALLET,
      signer,
      publicKey: signer.publicKey,
      permissions: {},
      expiry: 0,
    };
    const sig = await signErc1271(session, `0x${"22".repeat(32)}`);
    expect(sig).toMatch(/^0x/);
    expect(getCalls).toHaveLength(1);
    const opts: any = getCalls[0];
    expect(opts?.publicKey?.rpId).toBe(RP_ID);
  });

  test("signPreparedCalls signs a prepared digest via the injected getFn", async () => {
    const { signer, getCalls } = await makeSigner();
    const key = passkeyToPortoKey(signer, { role: "admin" });
    const sig = await signPreparedCalls(
      { digest: `0x${"33".repeat(32)}`, context: {} },
      key,
      { getFn: signer.webAuthn!.getFn! },
    );
    expect(sig).toMatch(/^0x/);
    expect(getCalls).toHaveLength(1);
  });

  test("headless keys ignore getFn — they sign locally", async () => {
    const headless = createHeadlessPasskey();
    const getCalls: unknown[] = [];
    const key = passkeyToPortoKey(headless, { role: "admin" });
    const sig = await signPreparedCalls(
      { digest: `0x${"44".repeat(32)}`, context: {} },
      key,
      { getFn: makeGetFn(P256.randomPrivateKey(), getCalls) },
    );
    expect(sig).toMatch(/^0x/);
    expect(getCalls).toHaveLength(0);
  });
});

describe("recoverFromPasskey with webAuthn.getFn", () => {
  const network = BNB_TESTNET;

  test("null from getFn → 'No passkey selected' (guard skipped, injection used)", async () => {
    await expect(
      recoverFromPasskey({ rpId: RP_ID, network, webAuthn: { getFn: (() => Promise.resolve(null)) as never } }),
    ).rejects.toThrow(/No passkey selected/);
  });

  test("a 32-byte userHandle is rejected before any RPC", async () => {
    const getFn = (() =>
      Promise.resolve({
        id: "AQID",
        response: { userHandle: new Uint8Array(32).buffer },
      } as never)) as never;
    await expect(recoverFromPasskey({ rpId: RP_ID, network, webAuthn: { getFn } })).rejects.toThrow(/expected 20/);
  });

  test("outside a browser, rpId is required with getFn", async () => {
    await expect(
      recoverFromPasskey({ network, webAuthn: { getFn: (() => Promise.resolve(null)) as never } }),
    ).rejects.toThrow(/rpId is required/);
  });
});
