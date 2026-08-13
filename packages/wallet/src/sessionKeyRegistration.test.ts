/**
 * Optional session-key KeyStore registration:
 *  - grantSession `register` flag (default registers; false = account-only)
 *  - revokeSession gating (no KeyStore.revokeKey for unregistered keys — an
 *    atomic-bundle revert there would make the key unrevocable)
 *  - registerSessionKey (lazy registry upgrade; idempotent)
 *  - grantSession forwarding the grant's transaction hash to its caller
 *
 * The relay/keystore boundary is mocked ONCE for this file via delegating
 * holders that DEFAULT TO THE REAL implementations: bun shares one module
 * registry across all test files (and loads files before running any tests),
 * so a static module mock would leak into other suites (it broke
 * client.balances.test.ts). Stubs are switched in only inside this file's
 * beforeEach and switched back in afterAll.
 */
import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { BNB } from "./config.js";
import { keyHashForSigner } from "./internal/erc1271.js";
import type { Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";

const realRelay = await import("./internal/relay.js");
const realKeystore = await import("./internal/keystore.js");

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
let confirmTxHash: Hex | undefined = undefined;

beforeEach(() => {
  submitted = null;
  feeReads = 0;
  keyIsRegistered = false;
  confirmStatus = "CONFIRMED";
  confirmTxHash = undefined;
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
  // Mirrors the real waitForCalls: the hash comes from a receipt, and a
  // confirmed intent does not always have one.
  waitForCallsImpl = async () => ({
    status: confirmStatus,
    ...(confirmTxHash ? { transactionHash: confirmTxHash } : {}),
  });
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

// ======================= grantSession transaction hash =======================
//
// Granting is the one call that charges the user: a KeyStore registration fee,
// paid twice on a wallet's very first admin action. Dropping the hash left
// integrators unable to record a receipt for it. execute, revokeSession and
// registerSessionKey all forward it; this is the regression guard for the entry
// point that used to be the exception.

const GRANT_TX_HASH =
  "0xfeed0000000000000000000000000000000000000000000000000000000000ff" as Hex;

/**
 * Run grantSession all the way to its return value.
 *
 * Every test above short-circuits on a FAILED status so grantSession throws
 * before its post-confirm waits. Reading the RETURN value means getting through
 * them, and they are slow on purpose: a getKeys visibility poll, then a relay
 * catch-up sleep of up to 12s (grantSession.ts). So report the session key as
 * already visible on chain, and hand the call a zero-delay setTimeout for its
 * duration, which collapses both waits. Tests in this file run sequentially and
 * the call is awaited, so nothing else observes the swapped timer.
 */
async function runGrantToCompletion(sessionSigner: Signer) {
  buildPublicClientImpl = () => ({
    readContract: async () => [[], [keyHashForSigner(sessionSigner)]],
  });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as any;
  try {
    return await grantSession(
      WALLET as any,
      createPrivateKeySigner(),
      {
        permissions: {},
        expiry: 1_800_000_000,
        sessionSigner,
        register: false, // account-only: the fee path is covered above
      } as any,
      { network: BNB },
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("grant forwards the transaction hash the relay reported", async () => {
  confirmTxHash = GRANT_TX_HASH;
  const sessionSigner = createPrivateKeySigner();

  const session = await runGrantToCompletion(sessionSigner);

  expect(session.transactionHash).toBe(GRANT_TX_HASH);
  // Still a usable Session: the hash is additive, not a replacement.
  expect(session.publicKey).toBe(sessionSigner.publicKey);
  expect(session.walletAddress).toBe(WALLET.address);
});

test("grant omits transactionHash entirely when the relay reports none", async () => {
  confirmTxHash = undefined;
  const sessionSigner = createPrivateKeySigner();

  const session = await runGrantToCompletion(sessionSigner);

  // Absent, not present-and-undefined. toBeUndefined() would pass for both, and
  // the key must not show up in a JSON round-trip of a persisted Session.
  expect("transactionHash" in session).toBe(false);
});
