/**
 * Optional session-key KeyStore registration:
 *  - grantSession `register` flag (default registers; false = account-only)
 *  - revokeSession gating (no KeyStore.revokeKey for unregistered keys — an
 *    atomic-bundle revert there would make the key unrevocable)
 *  - registerSessionKey (lazy registry upgrade; idempotent)
 *  - grantSession forwarding the grant's transaction hash to its caller
 *  - hireErc8183Agent's post-funding check only firing once confirmed (see
 *    the dedicated section at the bottom of this file)
 *
 * The relay/keystore boundary is mocked ONCE for this file via delegating
 * holders that DEFAULT TO THE REAL implementations: bun shares one module
 * registry across all test files (and loads files before running any tests),
 * so a static module mock would leak into other suites (it broke
 * client.balances.test.ts — and would again if a second file called
 * mock.module on the same path, which is why the erc8183 noWait tests live
 * here instead of in their own file). Stubs are switched in only inside this
 * file's beforeEach and switched back in afterAll.
 */
import { test, expect, mock, beforeEach, afterAll } from "bun:test";
import { decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { BNB } from "./config.js";
import { keyHashForSigner } from "./internal/erc1271.js";
import { hireErc8183Agent } from "./erc8183.js";
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
  // execute() goes through the detailed variant; same stub, wrapped.
  submitCallsDetailed: async (...a: any[]) => ({ callsId: await submitCallsImpl(...a) }),
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
  // Fail-fast after submit: a FAILED intent skips grantSession's multi-second
  // RPC-visibility wait; the bundle is captured and the result reports it.
  confirmStatus = "FAILED";
  const admin = createPrivateKeySigner();
  const sessionSigner = createPrivateKeySigner();
  const result = await grantSession(
    WALLET as any,
    admin,
    {
      permissions: {},
      expiry: 1_800_000_000,
      sessionSigner,
      ...(register === undefined ? {} : { register }),
    } as any,
    { networks: [BNB] },
  );
  expect(result.status).toBe("failed");
  expect(result.legs.find((l) => l.kind === "account")!.status).toBe("FAILED");
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

test("grant with a feeToken list adds a daily cap per fee token and returns the effective caps on the session", async () => {
  const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
  // The relay client the grant asks for accepted fee tokens: BNB plus a 18-dp USDT.
  buildRelayClientImpl = () =>
    ({
      request: async ({ method }: { method: string }) => {
        if (method !== "wallet_getCapabilities") throw new Error(`unexpected ${method}`);
        return {
          "0x38": {
            fees: {
              quoteConfig: { rateTtl: 300 },
              tokens: [
                { uid: "bnb", address: "0x0000000000000000000000000000000000000000", decimals: 18, feeToken: true, symbol: "BNB", nativeRate: "0xde0b6b3a7640000" },
                { uid: "usdt", address: USDT, decimals: 18, feeToken: true, symbol: "USDT", nativeRate: "0x3782dace9d90000" },
              ],
            },
          },
        };
      },
    }) as any;
  confirmTxHash = ("0x" + "ab".repeat(32)) as Hex;
  const sessionSigner = createPrivateKeySigner();
  // Same shortcuts as runGrantToCompletion: the key is already visible and the
  // relay catch-up delay is zero.
  buildPublicClientImpl = () => ({
    readContract: async () => [[], [keyHashForSigner(sessionSigner)]],
  });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as any;
  let session: Session;
  try {
    session = await grantSession(
      WALLET as any,
      createPrivateKeySigner(),
      {
        permissions: { calls: [{ to: WALLET.address }], spend: [{ limit: 5n, period: "day" }] },
        expiry: 1_800_000_000,
        sessionSigner,
        register: false,
      },
      { networks: [BNB], feeToken: [USDT, "0x0000000000000000000000000000000000000000"] },
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  // The native cap the caller set is kept; USDT gets one whole token per day.
  expect(session.permissions.spend).toEqual([
    { limit: 5n, period: "day" },
    { limit: 10n ** 18n, period: "day", token: USDT },
  ]);
  // The key authorized on the account carries the same caps, and the grant's
  // own fee goes through the same list.
  expect(submitted!.opts.authorizeKeys[0].permissions.spend).toEqual(session.permissions.spend);
  expect(submitted!.opts.feeToken).toEqual([USDT, "0x0000000000000000000000000000000000000000"]);
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

// Discovery reads the account's getKey; answering it means the key is held.
function accountHoldsKey() {
  buildPublicClientImpl = () => ({
    readContract: async () => ({ expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: "0x" }),
  });
}

test("revoke of a registered session: bundle revokes in KeyStore AND on the account", async () => {
  keyIsRegistered = true;
  accountHoldsKey();
  const admin = createPrivateKeySigner();
  const session = createPrivateKeySigner();

  const result = await revokeSession(WALLET as any, admin, session.publicKey, { networks: [BNB] });
  expect(result.status).toBe("revoked");
  expect(result.legs.map((l) => [l.kind, l.via ?? null])).toEqual([
    ["account", null],
    ["registry", "bundled"],
  ]);

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
  accountHoldsKey();
  const admin = createPrivateKeySigner();
  const session = createPrivateKeySigner();

  await revokeSession(WALLET as any, admin, session.publicKey, { networks: [BNB] });

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
// paid twice on a wallet's very first admin action. The hash of every intent
// rides on its leg so integrators can record a receipt for it.

const GRANT_TX_HASH =
  "0xfeed0000000000000000000000000000000000000000000000000000000000ff" as Hex;

/**
 * Run grantSession all the way to its return value. Report the session key
 * as already visible on chain, and hand the call a zero-delay setTimeout for
 * its duration, which collapses the visibility poll and the relay catch-up
 * sleep. Tests in this file run sequentially and the call is awaited, so
 * nothing else observes the swapped timer.
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
      { networks: [BNB] },
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("grant puts the transaction hash the relay reported on the account leg", async () => {
  confirmTxHash = GRANT_TX_HASH;
  const sessionSigner = createPrivateKeySigner();

  const session = await runGrantToCompletion(sessionSigner);

  expect(session.status).toBe("granted");
  expect(session.legs).toEqual([{ chainId: 56, kind: "account", status: "CONFIRMED", transactionHash: GRANT_TX_HASH }]);
  // Still a usable Session.
  expect(session.publicKey).toBe(sessionSigner.publicKey);
  expect(session.walletAddress).toBe(WALLET.address);
});

test("grant omits transactionHash on the leg when the relay reports none", async () => {
  confirmTxHash = undefined;
  const sessionSigner = createPrivateKeySigner();

  const session = await runGrantToCompletion(sessionSigner);

  // Absent, not present-and-undefined.
  expect("transactionHash" in session.legs[0]!).toBe(false);
  expect("transactionHash" in session).toBe(false);
});

// =================== hireErc8183Agent noWait post-check ======================
//
// With opts.noWait, execute() returns PENDING right after the relay *accepts*
// the intent — before it's mined. hireErc8183Agent's post-funding check reads
// getErc8183Job right after execute() returns, so on the noWait path it used
// to read pre-inclusion chain state and throw "job is not ours" on every
// call, even when the funding would go on to succeed. The check must only
// run once the batch has actually confirmed.

const HIRE_WALLET = { address: "0x2222222222222222222222222222222222222222" as Address };
let jobClientOnChain: Address;
let getJobCalled: boolean;

function mockErc8183Chain() {
  jobClientOnChain = "0x0000000000000000000000000000000000000000";
  getJobCalled = false;
  buildPublicClientImpl = () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "disputeWindow") return 3600n;
      if (functionName === "jobCounter") return 0n;
      if (functionName === "getJob") {
        getJobCalled = true;
        return {
          id: 1n,
          client: jobClientOnChain,
          provider: "0x0000000000000000000000000000000000000000",
          evaluator: "0x0000000000000000000000000000000000000000",
          description: "",
          budget: 0n,
          expiredAt: 0n,
          status: 1,
          hook: "0x0000000000000000000000000000000000000000",
          submittedAt: 0n,
          deliverable: `0x${"00".repeat(32)}` as Hex,
        };
      }
      throw new Error(`unexpected functionName ${functionName}`);
    },
  });
}

test("hireErc8183Agent noWait:true returns PENDING without reading pre-inclusion chain state", async () => {
  mockErc8183Chain(); // jobClientOnChain stays zero — as it would be pre-inclusion
  const admin = createPrivateKeySigner();

  const result = await hireErc8183Agent(
    HIRE_WALLET,
    admin,
    { provider: HIRE_WALLET.address, task: "test", budget: 1n },
    { network: BNB, noWait: true },
  );

  expect(result.status).toBe("PENDING");
  // The bug: this used to run unconditionally and throw here.
  expect(getJobCalled).toBe(false);
});

test("hireErc8183Agent default (waits) still verifies the job and throws on a real mismatch", async () => {
  mockErc8183Chain();
  jobClientOnChain = "0x9999999999999999999999999999999999999999"; // someone else's job
  const admin = createPrivateKeySigner();

  await expect(
    hireErc8183Agent(
      HIRE_WALLET,
      admin,
      { provider: HIRE_WALLET.address, task: "test", budget: 1n },
      { network: BNB },
    ),
  ).rejects.toThrow(/is not ours/);
  expect(getJobCalled).toBe(true);
});

test("hireErc8183Agent default (waits) succeeds and verifies when the job matches", async () => {
  mockErc8183Chain();
  jobClientOnChain = HIRE_WALLET.address;
  const admin = createPrivateKeySigner();

  const result = await hireErc8183Agent(
    HIRE_WALLET,
    admin,
    { provider: HIRE_WALLET.address, task: "test", budget: 1n },
    { network: BNB },
  );

  expect(result.status).toBe("CONFIRMED");
  expect(getJobCalled).toBe(true);
});
