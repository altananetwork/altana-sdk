/**
 * Optional session-key KeyStore registration:
 *  - grantSession `register` flag (default registers; false = account-only)
 *  - revokeSession gating (no KeyStore.revokeKey for unregistered keys — an
 *    atomic-bundle revert there would make the key unrevocable)
 *  - registerSessionKey (lazy registry upgrade; idempotent)
 *
 * The relay/keystore boundary is mocked ONCE for this file via delegating
 * holders that DEFAULT TO THE REAL implementations: bun shares one module
 * registry across all test files (and loads files before running any tests),
 * so a static module mock would leak into other suites (it broke
 * client.balances.test.ts). Stubs are switched in only inside this file's
 * beforeEach and switched back in afterAll.
 */
import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { decodeFunctionData, keccak256, type Address } from "viem";
import { BNB } from "./config.js";
import type { Session } from "./internal/sessions.js";

const realRelay = await import("./internal/relay.js");
const realKeystore = await import("./internal/keystore.js");

// Load the full SDK graph BEFORE mock.module runs. Loading a large module
// graph while mock hooks are registered deadlocks bun's loader on slow
// runners: client.balances.test.ts imports ./client.js after this file's
// mocks exist and CI hung there every run (bisect: only dropping this file
// cured it). With the graph cached up front, later files load nothing new.
await import("./client.js");

// ---- delegating holders (default: real) -----------------------------------
let submitCallsImpl: any = realRelay.submitCalls;
let waitForCallsImpl: any = realRelay.waitForCalls;
let buildPublicClientImpl: any = realRelay.buildPublicClient;
let buildRelayClientImpl: any = realRelay.buildRelayClient;
let readFeeImpl: any = realKeystore.readRegistrationFee;
let readIsValidKeyImpl: any = realKeystore.readIsValidKey;

mock.module("./internal/relay.js", () => ({
  ...realRelay,
  submitCalls: (...a: any[]) => submitCallsImpl(...a),
  waitForCalls: (...a: any[]) => waitForCallsImpl(...a),
  buildPublicClient: (...a: any[]) => buildPublicClientImpl(...a),
  buildRelayClient: (...a: any[]) => buildRelayClientImpl(...a),
}));
mock.module("./internal/keystore.js", () => ({
  ...realKeystore,
  readRegistrationFee: (...a: any[]) => readFeeImpl(...a),
  readIsValidKey: (...a: any[]) => readIsValidKeyImpl(...a),
}));

const { grantSession } = await import("./grantSession.js");
const { revokeSession } = await import("./revokeSession.js");
const { registerSessionKey } = await import("./registerSessionKey.js");
const { createPrivateKeySigner } = await import("./internal/signer.js");

// ---- per-test stub state ----------------------------------------------------
const FEE = 876_866_105_047_914n;
let submitted: { calls: any[]; opts: any } | null = null;
let feeReads = 0;
let keyIsRegistered = false;
let confirmStatus = "CONFIRMED";

beforeEach(() => {
  submitted = null;
  feeReads = 0;
  keyIsRegistered = false;
  confirmStatus = "CONFIRMED";
  submitCallsImpl = async (
    _relay: any,
    _wallet: any,
    _signer: any,
    calls: any[],
    opts: any,
  ) => {
    submitted = { calls, opts };
    return "0xcallsid";
  };
  waitForCallsImpl = async () => ({ status: confirmStatus });
  buildPublicClientImpl = () => ({}) as any;
  buildRelayClientImpl = () => ({}) as any;
  readFeeImpl = async () => {
    feeReads++;
    return FEE;
  };
  readIsValidKeyImpl = async () => keyIsRegistered;
});

// Hand the real implementations back to every suite that runs after this file.
afterAll(() => {
  submitCallsImpl = realRelay.submitCalls;
  waitForCallsImpl = realRelay.waitForCalls;
  buildPublicClientImpl = realRelay.buildPublicClient;
  buildRelayClientImpl = realRelay.buildRelayClient;
  readFeeImpl = realKeystore.readRegistrationFee;
  readIsValidKeyImpl = realKeystore.readIsValidKey;
});

// ---- fixtures ----------------------------------------------------------------
const CONTROLLER_ABI = [
  {
    name: "registerKey",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "keyId", type: "bytes32" },
      { name: "validator", type: "address" },
      { name: "metadata", type: "bytes" },
      { name: "publicKey", type: "bytes" },
      { name: "expiry", type: "uint40" },
    ],
    outputs: [],
  },
] as const;

const KEYSTORE_ABI = [
  {
    name: "revokeKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const WALLET = {
  address: "0x1111111111111111111111111111111111111111" as Address,
  chainId: 56,
};

function makeSession(): Session {
  const signer = createPrivateKeySigner();
  return {
    walletAddress: WALLET.address,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 1_800_000_000,
  };
}

// ============================ grantSession `register` ========================

async function runGrant(register?: boolean) {
  // Fail-fast after submit: waitForCalls FAILED makes grantSession throw
  // before its multi-second RPC-visibility wait; the bundle is captured.
  confirmStatus = "FAILED";
  const admin = createPrivateKeySigner();
  const sessionSigner = createPrivateKeySigner();
  await expect(
    grantSession(
      WALLET as any,
      admin,
      {
        permissions: {},
        expiry: 1_800_000_000,
        sessionSigner,
        ...(register === undefined ? {} : { register }),
      } as any,
      { network: BNB },
    ),
  ).rejects.toThrow("did not confirm");
  return sessionSigner;
}

test("default grant bundles the KeyStore registerKey call and reads the fee", async () => {
  const sessionSigner = await runGrant(undefined);

  expect(feeReads).toBe(1);
  expect(submitted!.calls.length).toBe(1);
  const { functionName, args } = decodeFunctionData({
    abi: CONTROLLER_ABI,
    data: submitted!.calls[0].data,
  });
  expect(functionName).toBe("registerKey");
  expect((args![3] as string).toLowerCase()).toBe(
    sessionSigner.publicKey.toLowerCase(),
  );
  expect(submitted!.calls[0].to).toBe(BNB.keyStoreController);
  expect(submitted!.opts.authorizeKeys.length).toBe(1);
});

test("register: true behaves like the default", async () => {
  await runGrant(true);
  expect(feeReads).toBe(1);
  expect(submitted!.calls.length).toBe(1);
});

test("register: false grants an account-only session — no KeyStore call, no fee read, authorization intact", async () => {
  const sessionSigner = await runGrant(false);

  expect(feeReads).toBe(0);
  expect(submitted!.calls.length).toBe(0);
  expect(submitted!.opts.authorizeKeys.length).toBe(1);
  expect(submitted!.opts.authorizeKeys[0].publicKey.toLowerCase()).toBe(
    sessionSigner.publicKey.toLowerCase(),
  );
});

// ============================ revokeSession gating ===========================

test("revoke of a registered session: bundle revokes in KeyStore AND on the account", async () => {
  keyIsRegistered = true;
  const admin = createPrivateKeySigner();
  const session = createPrivateKeySigner();

  await revokeSession(WALLET as any, admin, session.publicKey, { network: BNB });

  expect(submitted!.calls.length).toBe(1);
  const { functionName, args } = decodeFunctionData({
    abi: KEYSTORE_ABI,
    data: submitted!.calls[0].data,
  });
  expect(functionName).toBe("revokeKey");
  expect(args![1]).toBe(keccak256(session.publicKey));
  expect(submitted!.opts.revokeKeys.length).toBe(1);
});

test("revoke of an unregistered session: KeyStore call omitted so the account revoke cannot be reverted away", async () => {
  keyIsRegistered = false;
  const admin = createPrivateKeySigner();
  const session = createPrivateKeySigner();

  await revokeSession(WALLET as any, admin, session.publicKey, { network: BNB });

  expect(submitted!.calls.length).toBe(0);
  expect(submitted!.opts.revokeKeys.length).toBe(1);
  expect(submitted!.opts.revokeKeys[0].publicKey.toLowerCase()).toBe(
    session.publicKey.toLowerCase(),
  );
});

// ============================ registerSessionKey =============================

test("registerSessionKey registers an unregistered key: one registerKey call with the fee and the session's expiry, no authorizeKeys", async () => {
  keyIsRegistered = false;
  const admin = createPrivateKeySigner();
  const session = makeSession();

  const result = await registerSessionKey(WALLET as any, admin, session, {
    network: BNB,
  });

  expect(result.alreadyRegistered).toBe(false);
  expect(feeReads).toBe(1);
  expect(submitted!.calls.length).toBe(1);
  expect(submitted!.calls[0].to).toBe(BNB.keyStoreController);
  expect(submitted!.calls[0].value).toBe(FEE);

  const { functionName, args } = decodeFunctionData({
    abi: CONTROLLER_ABI,
    data: submitted!.calls[0].data,
  });
  expect(functionName).toBe("registerKey");
  expect((args![3] as string).toLowerCase()).toBe(session.publicKey.toLowerCase());
  expect(args![4]).toBe(session.expiry); // registry expiry mirrors the account's
  expect(submitted!.opts.authorizeKeys).toBeUndefined(); // registry-only
});

test("registerSessionKey is idempotent: an already-registered key submits nothing and pays nothing", async () => {
  keyIsRegistered = true;
  const admin = createPrivateKeySigner();
  const session = makeSession();

  const result = await registerSessionKey(WALLET as any, admin, session, {
    network: BNB,
  });

  expect(result.alreadyRegistered).toBe(true);
  expect(feeReads).toBe(0);
  expect(submitted).toBeNull();
});
