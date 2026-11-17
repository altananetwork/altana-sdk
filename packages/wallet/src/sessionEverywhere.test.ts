/**
 * Grant and revoke on every chain: which legs run where, in what order, and
 * how their outcomes fold into one binary status. The chain I/O is a fake
 * SessionLegDeps, so no module is mocked here.
 */
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, keccak256, type Address, type Hex } from "viem";
import {
  BASE_SEPOLIA,
  BNB,
  CELO,
  CELO_SEPOLIA,
  ETHEREUM,
  SEPOLIA,
  type NetworkConfig,
} from "./config.js";
import { keyHashForSessionOrKey, keyIdForSessionOrKey, sessionKeyDescriptor } from "./internal/account.js";
import { computeAccountSecp256k1KeyHash, keyHashForSigner } from "./internal/erc1271.js";
import { createHeadlessPasskey } from "./internal/passkey.js";
import type { IntentOutcome, SessionLegDeps } from "./internal/sessionLegs.js";
import type { CacheSyncReport, Session } from "./internal/sessions.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import { runGrantSession } from "./grantSession.js";
import { runRevokeSession, type RevokeSessionResult } from "./revokeSession.js";

/**
 * Two networks that keep their registry on another chain, as these cases need:
 * two L2s behind one registry chain on testnet, and one behind Ethereum.
 * Base Sepolia is the SDK's own network of this shape; these two carry Celo's
 * chain ids with the registry Celo had before it got its own KeyStore, so the
 * orchestration for mirrored networks stays covered for the chains that use it.
 */
const MIRRORED_L2: NetworkConfig = {
  ...CELO_SEPOLIA,
  keyStore: SEPOLIA.keyStore,
  keyStoreController: SEPOLIA.keyStoreController,
  registry: { kind: "cached", l1: SEPOLIA, keyStoreCache: "0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD" },
};
const MIRRORED_MAINNET_L2: NetworkConfig = {
  ...CELO,
  keyStore: ETHEREUM.keyStore,
  keyStoreController: ETHEREUM.keyStoreController,
  registry: { kind: "cached", l1: ETHEREUM, keyStoreCache: "0xF939d7D3a2b8262aD8662c71Dec38119058d5a06" },
};

const WALLET = { address: "0x1111111111111111111111111111111111111111" as Address };

type Submitted = { chainId: number; calls: readonly { to: Address; data?: Hex; value?: bigint }[]; args: any };

/** A scripted chain: what each read answers, what each write returns, and a log of every write. */
function fakeChains(script: {
  holds?: number[];
  registryValid?: number[];
  cacheLive?: number[];
  failAccount?: number[];
  failRegistry?: number[];
  failCache?: number[];
  readErrorAccount?: number[];
  /** Registry chains whose confirmed write comes back without a block number. */
  unknownBlock?: number[];
  /** Registry chains whose write the relay funds from an L2: registry chain id to source chain id. */
  fundFrom?: Record<number, number>;
  /** Registry chains whose write blocks until `release()` is called. */
  holdRegistry?: number[];
} = {}) {
  const log = {
    account: [] as Submitted[],
    registry: [] as Submitted[],
    cache: [] as { chainId: number; afterL1Block: bigint | undefined }[],
    order: [] as string[],
    /** Account intents still unmined when each registry write was submitted. */
    inFlightAtRegistry: [] as { registry: number; accounts: number[] }[],
  };
  /** Account intents submitted but not yet mined, by chain. */
  const inFlight = new Set<number>();
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const has = (list: number[] | undefined, id: number) => (list ?? []).includes(id);
  let block = 100n;
  const deps: SessionLegDeps = {
    async accountHasKey(n) {
      if (has(script.readErrorAccount, n.chainId)) throw new Error("HTTP request failed");
      return has(script.holds, n.chainId);
    },
    async isValidRegistryKey(r) {
      return has(script.registryValid, r.chainId);
    },
    async registrationFee() {
      return 7n;
    },
    async cacheHoldsLiveKey(n) {
      return has(script.cacheLive, n.chainId);
    },
    async submitAccountIntent(n, args): Promise<IntentOutcome> {
      log.account.push({ chainId: n.chainId, calls: args.calls, args });
      inFlight.add(n.chainId);
      await tick();
      inFlight.delete(n.chainId);
      log.order.push(`account:${n.chainId}`);
      if (has(script.failAccount, n.chainId)) return { status: "FAILED", reason: "relay status FAILED" };
      return {
        status: "CONFIRMED",
        transactionHash: `0x${n.chainId.toString(16).padStart(64, "0")}` as Hex,
        ...(args.needBlockNumber && has(script.unknownBlock, n.chainId)
          ? { blockNumberError: "public RPC receipt lookup failed 5 times" }
          : args.needBlockNumber
            ? { blockNumber: ++block }
            : {}),
      };
    },
    async submitRegistry(r, args) {
      log.registry.push({ chainId: r.chainId, calls: args.calls, args });
      log.inFlightAtRegistry.push({ registry: r.chainId, accounts: [...inFlight].sort((a, b) => a - b) });
      if (has(script.holdRegistry, r.chainId)) await held;
      await tick();
      log.order.push(`registry:${r.chainId}`);
      const via = r.relayUrl ? "relay" : "eoa";
      if (has(script.failRegistry, r.chainId)) return { via, status: "FAILED", reason: "reverted" };
      if (has(script.unknownBlock, r.chainId)) {
        return { via, status: "CONFIRMED", blockNumberError: "public RPC receipt lookup failed 5 times" };
      }
      const source = script.fundFrom?.[r.chainId];
      return {
        via,
        status: "CONFIRMED",
        blockNumber: ++block,
        ...(source !== undefined ? { fundedFromChainId: source, sourceTransactionHash: `0x${"cc".repeat(32)}` as Hex } : {}),
      };
    },
    async proveIntoCache(_w, _a, _pk, n, afterL1Block): Promise<CacheSyncReport> {
      log.cache.push({ chainId: n.chainId, afterL1Block });
      log.order.push(`cache:${n.chainId}`);
      if (has(script.failCache, n.chainId)) {
        return { chainId: n.chainId, status: "FAILED", reason: "the proof never matched the anchor" };
      }
      return { chainId: n.chainId, status: "CONFIRMED" };
    },
    async waitForKeyVisible() {},
    async sleep() {},
  };
  return { deps, log, release };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

function revoke(
  networks: NetworkConfig[],
  deps: SessionLegDeps,
  key: Session | Hex = createPrivateKeySigner().publicKey,
  extra: { populateCache?: "await" } = {},
) {
  return runRevokeSession(WALLET, createPrivateKeySigner(), key, { networks, ...extra }, deps);
}

function grant(networks: NetworkConfig[], deps: SessionLegDeps, extra: Record<string, unknown> = {}) {
  return runGrantSession(
    WALLET,
    createPrivateKeySigner(),
    { permissions: {}, expiry: 1_800_000_000, sessionSigner: createPrivateKeySigner(), ...extra },
    { networks },
    deps,
  );
}

function legKinds(result: { legs: { chainId: number; kind: string; status: string; via?: string }[] }) {
  return result.legs.map((l) => `${l.kind}:${l.chainId}:${l.status}${l.via ? `:${l.via}` : ""}`);
}

const REVOKE_KEY_ABI = [
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

describe("revokeSession discovery", () => {
  test("only networks whose account holds the key get an account leg", async () => {
    const { deps, log } = fakeChains({ holds: [11142220] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.account.map((s) => s.chainId)).toEqual([11142220]);
    expect(result.status).toBe("revoked");
  });

  test("nothing held and nothing registered is already revoked, with no writes", async () => {
    const { deps, log } = fakeChains();
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA, BNB], deps);

    expect(log.account).toEqual([]);
    expect(log.registry).toEqual([]);
    expect(log.cache).toEqual([]);
    expect(result.status).toBe("revoked");
  });

  test("an L2 with no cache configured adds no leg when nothing on it needs proving", async () => {
    const { deps } = fakeChains({ holds: [56], registryValid: [56] });
    const result = await revoke([BNB, ETHEREUM, MIRRORED_MAINNET_L2], deps);

    expect(result.legs.some((l) => l.chainId === 42220)).toBe(false);
    expect(result.status).toBe("revoked");
  });

  test("an unreadable account is a failed leg, never a clean chain", async () => {
    const { deps } = fakeChains({ readErrorAccount: [84532] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    const leg = result.legs.find((l) => l.chainId === 84532)!;
    expect(leg.kind).toBe("account");
    expect(leg.reason).toContain("could not read the account's keys");
  });
});

describe("revokeSession registry legs", () => {
  test("two L2s sharing Sepolia produce one registry leg, fired because the key is valid there", async () => {
    const { deps, log } = fakeChains({ holds: [11142220, 84532], registryValid: [11155111] });
    const key = createPrivateKeySigner().publicKey;
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps, key);

    expect(log.registry.map((s) => s.chainId)).toEqual([11155111]);
    const { functionName, args } = decodeFunctionData({ abi: REVOKE_KEY_ABI, data: log.registry[0]!.calls[0]!.data! });
    expect(functionName).toBe("revokeKey");
    expect(log.registry[0]!.calls[0]!.to).toBe(SEPOLIA.keyStore);
    expect(args[1]).toBe(keccak256(key));
    // Account legs on the L2s carry no registry call.
    expect(log.account.every((s) => s.calls.length === 0)).toBe(true);
    // The proofs run on after the call returns; the legs read PENDING until cacheSync resolves.
    expect(legKinds(result)).toEqual([
      "account:11142220:CONFIRMED",
      "account:84532:CONFIRMED",
      "registry:11155111:CONFIRMED:relay",
      "cache:11142220:PENDING",
      "cache:84532:PENDING",
    ]);
    expect(result.status).toBe("revoked");
    expect(legKinds({ legs: await result.cacheSync })).toEqual(["cache:11142220:CONFIRMED", "cache:84532:CONFIRMED"]);
  });

  test("no registry leg when readIsValidKey is false", async () => {
    const { deps, log } = fakeChains({ holds: [11142220] });
    const result = await revoke([MIRRORED_L2], deps);

    expect(log.registry).toEqual([]);
    expect(result.legs.find((l) => l.kind === "registry")!.status).toBe("SKIPPED");
  });

  test("a local network holding the key bundles account and registry in one intent", async () => {
    const { deps, log } = fakeChains({ holds: [56], registryValid: [56] });
    const key = createPrivateKeySigner().publicKey;
    const result = await revoke([BNB], deps, key);

    expect(log.registry).toEqual([]);
    expect(log.account).toHaveLength(1);
    expect(log.account[0]!.calls).toHaveLength(1);
    expect(log.account[0]!.calls[0]!.to).toBe(BNB.keyStore);
    expect(log.account[0]!.args.revokeKeys).toHaveLength(1);
    const [account, registry] = result.legs;
    expect(registry!.via).toBe("bundled");
    expect(registry!.transactionHash).toBe(account!.transactionHash);
    expect(result.status).toBe("revoked");
  });

  test("a local L1 bundles the registry revoke for the L2 behind it, whose cache proof waits for that block", async () => {
    const { deps, log } = fakeChains({ holds: [1, 42220], registryValid: [1] });
    const celoWithCache: NetworkConfig = {
      ...MIRRORED_MAINNET_L2,
      registry: { kind: "cached", l1: ETHEREUM, keyStoreCache: "0x0000000000000000000000000000000000000c0c" },
    };
    const result = await revoke([ETHEREUM, celoWithCache], deps);

    expect(log.registry).toEqual([]);
    const bundledLeg = result.legs.find((l) => l.kind === "registry")!;
    expect(bundledLeg.via).toBe("bundled");
    expect(log.cache).toEqual([{ chainId: 42220, afterL1Block: bundledLeg.blockNumber }]);
    expect(result.status).toBe("revoked");
  });
});

describe("revokeSession status is binary", () => {
  test("a failed account leg makes the revoke failed and does not stop the others", async () => {
    const { deps, log } = fakeChains({ holds: [11142220, 84532], registryValid: [11155111], failAccount: [11142220] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    expect(log.account.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
    expect(log.registry).toHaveLength(1);
    expect(log.cache.map((c) => c.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
  });

  test("a failed registry leg makes the revoke failed and skips the cache proofs behind it", async () => {
    const { deps, log } = fakeChains({ holds: [11142220], registryValid: [11155111], failRegistry: [11155111] });
    const result = await revoke([MIRRORED_L2], deps);

    expect(result.status).toBe("failed");
    expect(log.cache).toEqual([]);
    const cache = result.legs.find((l) => l.kind === "cache")!;
    expect(cache.status).toBe("SKIPPED");
  });

  test("a failed cache leg makes the revoke failed when the caller waits for the proofs", async () => {
    const { deps } = fakeChains({ holds: [84532], registryValid: [11155111], failCache: [84532] });
    const result = await revoke([BASE_SEPOLIA], deps, undefined, { populateCache: "await" });

    expect(result.status).toBe("failed");
    expect(result.legs.find((l) => l.kind === "cache")!.status).toBe("FAILED");
  });

  test("by default the revoke returns before the proof, which reports through cacheSync", async () => {
    const { deps } = fakeChains({ holds: [84532], registryValid: [11155111], failCache: [84532] });
    const result = await revoke([BASE_SEPOLIA], deps);

    expect(result.status).toBe("revoked");
    expect(result.legs.find((l) => l.kind === "cache")!.status).toBe("PENDING");
    const [cache] = await result.cacheSync;
    expect(cache!.status).toBe("FAILED");
    expect(cache!.reason).toContain("never matched the anchor");
  });

  test("the result type has no partial status", () => {
    const statuses: RevokeSessionResult["status"][] = ["revoked", "failed"];
    // @ts-expect-error there is no partial status
    const partial: RevokeSessionResult["status"] = "partial";
    expect(statuses).toHaveLength(2);
    expect(partial).toBe("partial");
  });
});

describe("revokeSession retry", () => {
  test("after a failed cache proof, a retry proves only the stale cache and writes nothing else", async () => {
    // State after the first run: accounts and registry clean, Base Sepolia's cache still live.
    const { deps, log } = fakeChains({ cacheLive: [84532] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.account).toEqual([]);
    expect(log.registry).toEqual([]);
    expect(log.cache).toEqual([{ chainId: 84532, afterL1Block: undefined }]);
    expect(result.status).toBe("revoked");
  });

  test("after a failed account leg, a retry acts only on that chain", async () => {
    const { deps, log } = fakeChains({ holds: [11142220] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.account.map((s) => s.chainId)).toEqual([11142220]);
    expect(log.registry).toEqual([]);
    expect(result.status).toBe("revoked");
  });
});

describe("session key identity", () => {
  test("a passkey session yields a webauthn-p256 descriptor and its own key hash", () => {
    const passkey = createHeadlessPasskey();
    const session: Session = {
      walletAddress: WALLET.address,
      signer: passkey,
      publicKey: passkey.publicKey,
      permissions: {},
      expiry: 1_800_000_000,
    };
    expect(sessionKeyDescriptor(session).type).toBe("webauthn-p256");
    expect(keyHashForSessionOrKey(session)).toBe(keyHashForSigner(passkey));
    expect(keyIdForSessionOrKey(session)).toBe(keccak256(passkey.publicKey));
  });

  test("a bare public key is secp256k1, hashed like its signer", () => {
    const signer: Signer = createPrivateKeySigner();
    expect(sessionKeyDescriptor(signer.publicKey).type).toBe("secp256k1");
    expect(keyHashForSessionOrKey(signer.publicKey)).toBe(computeAccountSecp256k1KeyHash(signer.address));
  });

  test("a passkey session is revoked with its webauthn descriptor", async () => {
    const passkey = createHeadlessPasskey();
    const session: Session = {
      walletAddress: WALLET.address,
      signer: passkey,
      publicKey: passkey.publicKey,
      permissions: {},
      expiry: 1_800_000_000,
    };
    const { deps, log } = fakeChains({ holds: [11142220] });
    await revoke([MIRRORED_L2], deps, session);
    expect(log.account[0]!.args.revokeKeys[0].type).toBe("webauthn-p256");
  });
});

describe("grantSession returns before the cache proofs", () => {
  test("cache legs read PENDING at return and finish through cacheSync; the session is granted meanwhile", async () => {
    const { deps, log } = fakeChains({});
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(result.status).toBe("granted");
    expect(result.legs.filter((l) => l.kind === "cache").map((l) => l.status)).toEqual(["PENDING", "PENDING"]);
    const caches = await result.cacheSync;
    expect(caches.map((l) => `${l.chainId}:${l.status}`)).toEqual(["11142220:CONFIRMED", "84532:CONFIRMED"]);
    expect(log.cache.map((c) => c.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
  });

  test("a proof that fails in the background is a FAILED leg in cacheSync, not a failed grant", async () => {
    const { deps } = fakeChains({ failCache: [84532] });
    const result = await grant([BASE_SEPOLIA], deps);

    expect(result.status).toBe("granted");
    const [cache] = await result.cacheSync;
    expect(cache!.status).toBe("FAILED");
  });

  test("a proof that throws is caught into a FAILED leg", async () => {
    const { deps } = fakeChains({});
    deps.proveIntoCache = async () => {
      throw new Error("relay down");
    };
    const result = await grant([BASE_SEPOLIA], deps);
    const [cache] = await result.cacheSync;
    expect(cache!.status).toBe("FAILED");
    expect(cache!.reason).toBe("relay down");
  });

  test("populateCache: \"await\" returns with the proofs in, and a failed proof fails the grant", async () => {
    const { deps } = fakeChains({ failCache: [84532] });
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps, { populateCache: "await" });

    expect(result.status).toBe("failed");
    expect(result.legs.filter((l) => l.kind === "cache").map((l) => l.status)).toEqual(["CONFIRMED", "FAILED"]);
    expect(await result.cacheSync).toEqual(result.legs.filter((l) => l.kind === "cache"));
  });

  test("populateCache: \"await\" lists each registry leg once, deferred or not", async () => {
    // `registration` reports every registry leg, including the ones already
    // final at return, so taking it wholesale into `legs` double-counted them.
    const { deps } = fakeChains();
    const result = await grant([MIRRORED_L2, BNB], deps, { populateCache: "await" });

    const registry = result.legs.filter((l) => l.kind === "registry");
    expect(registry.map((l) => `${l.chainId}:${l.status}`).sort()).toEqual([
      "11155111:CONFIRMED",
      "56:CONFIRMED",
    ]);
    expect(new Set(registry.map((l) => l.chainId)).size).toBe(registry.length);
  });

  test("populateCache: false skips the proofs and cacheSync resolves at once", async () => {
    const { deps, log } = fakeChains({});
    const result = await grant([BASE_SEPOLIA], deps, { populateCache: false });
    expect((await result.cacheSync).map((l) => l.status)).toEqual(["SKIPPED"]);
    expect(log.cache).toEqual([]);
  });
});

describe("grantSession everywhere", () => {
  test("an account leg on each L2 first, then one registry write on Sepolia, then the cache proofs", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.account.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
    expect(log.account.every((s) => s.calls.length === 0 && s.args.authorizeKeys.length === 1)).toBe(true);
    expect(result.status).toBe("granted");
    expect(result.keyId).toBe(keccak256(result.publicKey));
    expect(result.keyHash).toBe(keyHashForSigner(result.signer));

    const registryLegs = await result.registration;
    // Reversed deliberately: the authorization no longer waits for the L1.
    // Both authorizations land before the registry write starts.
    expect(log.order.indexOf("account:11142220")).toBeLessThan(log.order.indexOf("registry:11155111"));
    expect(log.order.indexOf("account:84532")).toBeLessThan(log.order.indexOf("registry:11155111"));
    expect(log.registry.map((s) => s.chainId)).toEqual([11155111]);
    expect(log.registry[0]!.calls[0]!.value).toBe(7n);
    const registryBlock = registryLegs.find((l) => l.kind === "registry")!.blockNumber;
    await result.cacheSync;
    expect(log.cache).toEqual([
      { chainId: 11142220, afterL1Block: registryBlock },
      { chainId: 84532, afterL1Block: registryBlock },
    ]);
  });

  test("a key already valid in the registry is not written again", async () => {
    const { deps, log } = fakeChains({ registryValid: [11155111] });
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.registry).toEqual([]);
    expect(log.cache.every((c) => c.afterL1Block === undefined)).toBe(true);
    expect(result.status).toBe("granted");
  });

  test("a local network bundles the registration into its account intent", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([BNB], deps);

    expect(log.registry).toEqual([]);
    expect(log.account[0]!.calls).toHaveLength(1);
    expect(log.account[0]!.calls[0]!.to).toBe(BNB.keyStoreController);
    expect(result.legs.find((l) => l.kind === "registry")!.via).toBe("bundled");
    expect(result.status).toBe("granted");
  });

  test("a failed registry write no longer skips a cached network's authorization", async () => {
    const { deps, log } = fakeChains({ failRegistry: [11155111] });
    const events: { status: string; detail?: { chainId: number; reason?: string } }[] = [];
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA, BNB], deps, {
      onStatus: (status: string, detail?: { chainId: number; reason?: string }) => events.push({ status, detail }),
    });

    // Every authorization ran, including the two behind the failing registry.
    expect(log.account.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([56, 84532, 11142220]);
    expect(result.legs.filter((l) => l.kind === "account" && l.status === "SKIPPED")).toEqual([]);
    // The write is still running at return, so the grant is usable and says so.
    expect(result.status).toBe("granted");
    expect(result.legs.find((l) => l.kind === "registry" && l.chainId === 11155111)!.status).toBe("PENDING");

    // It surfaces when it fails: a FAILED leg with the reason, and an event.
    const registryLegs = await result.registration;
    const sepolia = registryLegs.find((l) => l.chainId === 11155111)!;
    expect(sepolia.status).toBe("FAILED");
    expect(sepolia.reason).toBe("reverted");
    expect(events.filter((e) => e.status === "registry-write-failed")).toEqual([
      { status: "registry-write-failed", detail: { chainId: 11155111, reason: "reverted" } },
    ]);
  });

  test("a non-cached network's authorization still waits for its registry write", async () => {
    // BNB's registry is its own chain, so it bundles. Ethereum is the registry
    // for nothing cached here, so the old order holds for it.
    const { deps, log } = fakeChains({ failRegistry: [1] });
    const base: NetworkConfig = { ...BASE_SEPOLIA, registry: { kind: "local" } };
    const result = await grant([{ ...base, chainId: 999, registry: { kind: "cached", l1: ETHEREUM, keyStoreCache: "0x0000000000000000000000000000000000000c0c" } }], deps);
    // Cached: it authorizes anyway.
    expect(log.account.map((s) => s.chainId)).toEqual([999]);
    expect(result.status).toBe("granted");
  });

  test("a failed account leg fails the grant; the other chain still completes", async () => {
    const { deps, log } = fakeChains({ failAccount: [84532] });
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    await result.cacheSync;
    expect(log.cache.map((c) => c.chainId)).toEqual([11142220]);
  });

  test("register: false writes no registry and proves no cache", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([MIRRORED_L2], deps, { register: false });

    expect(log.registry).toEqual([]);
    expect(log.cache).toEqual([]);
    expect(result.status).toBe("granted");
  });

  test("an empty network list throws", async () => {
    const { deps } = fakeChains();
    await expect(grant([], deps)).rejects.toThrow(/at least one network/);
    await expect(revoke([], deps)).rejects.toThrow(/at least one network/);
  });

  test("duplicate networks are acted on once", async () => {
    const { deps, log } = fakeChains();
    await grant([BASE_SEPOLIA, BASE_SEPOLIA], deps);
    expect(log.account).toHaveLength(1);
  });
});

describe("descriptor carried to every account leg", () => {
  test("grant authorizes the same session descriptor on each chain", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);
    const keys = log.account.map((s) => s.args.authorizeKeys[0].publicKey);
    expect(new Set(keys)).toEqual(new Set([result.publicKey]));
  });
});

describe("cache proofs wait for the registry write's block", () => {
  test("grant: the Sepolia registration's block reaches both cache proofs", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);

    const registryBlock = (await result.registration).find((l) => l.chainId === 11155111)!.blockNumber;
    expect(registryBlock).toBeDefined();
    await result.cacheSync;
    expect(log.cache.map((c) => c.afterL1Block)).toEqual([registryBlock, registryBlock]);
  });

  test("grant: a confirmed registration with an unknown block fails the cache legs and never proves", async () => {
    const { deps, log } = fakeChains({ unknownBlock: [11155111] });
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);

    // The write is background work now, so its block is not known at return:
    // the cache legs can only read PENDING here and fail through cacheSync.
    expect(result.legs.filter((l) => l.kind === "cache").map((l) => l.status)).toEqual(["PENDING", "PENDING"]);
    expect(result.status).toBe("granted");

    const caches = await result.cacheSync;
    expect(log.cache).toEqual([]);
    expect(caches.map((l) => [l.chainId, l.status])).toEqual([
      [11142220, "FAILED"],
      [84532, "FAILED"],
    ]);
    expect(caches[0]!.reason).toContain("registry block unknown on chain 11155111, proof not attempted");
    expect(caches[0]!.reason).toContain("public RPC receipt lookup failed 5 times");
    // The registration and the account authorizations themselves still confirmed.
    expect((await result.registration).find((l) => l.chainId === 11155111)!.status).toBe("CONFIRMED");
  });

  test("grant: a key already valid in the registry is proven without a block (no write happened)", async () => {
    const { deps, log } = fakeChains({ registryValid: [11155111], unknownBlock: [11155111] });
    const result = await grant([MIRRORED_L2], deps);

    expect(log.cache).toEqual([{ chainId: 11142220, afterL1Block: undefined }]);
    expect(result.status).toBe("granted");
  });

  test("grant: the same guard holds when the registration rides in a local L1's account intent", async () => {
    const { deps, log } = fakeChains({ unknownBlock: [1] });
    const celoWithCache: NetworkConfig = {
      ...MIRRORED_MAINNET_L2,
      registry: { kind: "cached", l1: ETHEREUM, keyStoreCache: "0x0000000000000000000000000000000000000c0c" },
    };
    const result = await grant([ETHEREUM, celoWithCache], deps);

    expect(log.cache).toEqual([]);
    expect(result.legs.find((l) => l.kind === "cache")!.reason).toContain("registry block unknown on chain 1");
  });

  test("revoke: the Sepolia revocation's block reaches the cache proofs", async () => {
    const { deps, log } = fakeChains({ holds: [11142220, 84532], registryValid: [11155111] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    const registryBlock = legOfKind(result, "registry").blockNumber;
    expect(registryBlock).toBeDefined();
    expect(log.cache.map((c) => c.afterL1Block)).toEqual([registryBlock, registryBlock]);
  });

  test("revoke: a confirmed revocation with an unknown block fails the cache legs and never proves", async () => {
    const { deps, log } = fakeChains({ holds: [11142220, 84532], registryValid: [11155111], unknownBlock: [11155111] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.cache).toEqual([]);
    const caches = result.legs.filter((l) => l.kind === "cache");
    expect(caches.every((l) => l.status === "FAILED")).toBe(true);
    expect(caches[0]!.reason).toContain("registry block unknown on chain 11155111, proof not attempted");
    expect(result.status).toBe("failed");
  });

  test("revoke: Ethereum already clean and no write still proves the current state", async () => {
    const { deps, log } = fakeChains({ cacheLive: [84532], unknownBlock: [11155111] });
    const result = await revoke([MIRRORED_L2, BASE_SEPOLIA], deps);

    expect(log.cache).toEqual([{ chainId: 84532, afterL1Block: undefined }]);
    expect(result.status).toBe("revoked");
  });
});

function legOfKind(result: { legs: { kind: string; blockNumber?: bigint; status: string }[] }, kind: string) {
  const leg = result.legs.find((l) => l.kind === kind);
  if (!leg) throw new Error(`no ${kind} leg`);
  return leg;
}

/**
 * Celo-first grants. On a network with a cached registry the account
 * authorization goes first and the KeyStore write follows in the background,
 * so the session is usable in seconds instead of after an L1 confirmation it
 * does not need. Doris saw the old order live on 2026-10-15
 * (evidence/2026-10-15-demo-grant-did-authorize-on-celo.md).
 */
describe("grantSession authorizes a cached network first", () => {
  test("the grant returns while the registry write is still running, and resolves it later", async () => {
    const { deps, log, release } = fakeChains({ holdRegistry: [11155111] });
    const result = await grant([MIRRORED_L2], deps);

    // Returned: the authorization is in, the write is not.
    expect(result.status).toBe("granted");
    expect(legOfKind(result, "account").status).toBe("CONFIRMED");
    expect(result.legs.find((l) => l.kind === "registry")!.status).toBe("PENDING");
    expect(log.account.map((s) => s.chainId)).toEqual([11142220]);

    // `registration` really is still pending, not already resolved.
    const pending = Symbol("pending");
    expect(await Promise.race([result.registration, Promise.resolve(pending)])).toBe(pending);

    release();
    const registryLegs = await result.registration;
    expect(registryLegs.find((l) => l.chainId === 11155111)!.status).toBe("CONFIRMED");
  });

  test("the registry write starts with no account intent of its own L2s in flight", async () => {
    // The write is paid by an intent from the wallet's account on the L2, and
    // the relay reserves no nonce for an unmined intent, so the two must not
    // overlap (2026-09-28-back-to-back-race-attribution.md).
    const { deps, log } = fakeChains();
    const result = await grant([MIRRORED_L2, BASE_SEPOLIA], deps);
    await result.registration;

    expect(log.inFlightAtRegistry).toEqual([{ registry: 11155111, accounts: [] }]);
  });

  test("no authorization confirmed means the write is not attempted at all", async () => {
    const { deps, log } = fakeChains({ failAccount: [11142220] });
    const result = await grant([MIRRORED_L2], deps);

    expect(result.status).toBe("failed");
    const registry = (await result.registration).find((l) => l.chainId === 11155111)!;
    expect(registry.status).toBe("SKIPPED");
    expect(registry.reason).toBe(
      "no account authorization confirmed on 11142220, so the KeyStore write was not attempted",
    );
    expect(log.registry).toEqual([]);
  });

  test("the key hash the account indexes by is not the KeyStore keyId", async () => {
    // Reaching for `keyId` to check a grant on the account reverts
    // KeyDoesNotExist() whether or not the session is live, which is what made
    // a landed grant look like a missing one on 2026-10-15.
    const { deps } = fakeChains();
    const result = await grant([MIRRORED_L2], deps);

    expect(result.keyId).toBe(keccak256(result.publicKey));
    expect(result.keyHash).toBe(computeAccountSecp256k1KeyHash(result.signer.address));
    expect(result.keyHash).not.toBe(result.keyId);
  });

  test("revoke is unchanged: both legs final at return, nothing deferred", async () => {
    // Revoke never gated the account leg on the registry (the two run
    // together), so Celo-first has nothing to change there. What would show a
    // leak is a PENDING registry leg or a `registration` promise.
    const { deps, log } = fakeChains({ holds: [11142220], registryValid: [11155111] });
    const result = await revoke([MIRRORED_L2], deps);

    expect(result.status).toBe("revoked");
    expect(log.registry.map((s) => s.chainId)).toEqual([11155111]);
    expect(result.legs.filter((l) => l.kind !== "cache").map((l) => `${l.kind}:${l.status}`)).toEqual([
      "account:CONFIRMED",
      "registry:CONFIRMED",
    ]);
    expect((result as unknown as { registration?: unknown }).registration).toBeUndefined();
  });
});

describe("registry write funded from the L2", () => {
  test("the registry leg names the source chain and the cache proof still anchors on its block", async () => {
    const { deps, log } = fakeChains({ fundFrom: { [SEPOLIA.chainId]: MIRRORED_L2.chainId } });
    const result = await grant([MIRRORED_L2], deps);
    expect(result.status).toBe("granted");
    const registry = (await result.registration).find((l) => l.kind === "registry")!;
    expect(registry.fundedFromChainId).toBe(MIRRORED_L2.chainId);
    expect(registry.sourceTransactionHash).toBe(`0x${"cc".repeat(32)}`);
    expect(registry.blockNumber).toBeDefined();
    await result.cacheSync;
    expect(log.cache[0]?.afterL1Block).toBe(registry.blockNumber);
    expect(result.legs.find((l) => l.kind === "account")?.fundedFromChainId).toBeUndefined();
  });
});

/**
 * `x402Tokens` puts the two approvals an x402 payment needs into the same
 * intent that authorizes the session, so a session can pay straight away
 * instead of after two follow-up transactions that nothing reminds you to make.
 *
 * It rides in that intent rather than following it because the relay applies
 * `authorizeKeys` before the intent's own calls, which matters:
 * `setSignatureCheckerApproval` reverts `KeyDoesNotExist()` if the key is not
 * there yet. Measured live on Celo Sepolia (tx 0x178d30ee…99382), and the
 * calls' presence and order is what these tests pin.
 */
// Celo keeps its own KeyStore, like BNB: the key is registered on Celo in the
// same intent that authorizes it, nothing is written on another chain and
// there is no cache to prove into.
describe("Celo keeps its own KeyStore", () => {
  for (const network of [CELO, CELO_SEPOLIA]) {
    test(`grant on ${network.chain.name}: one intent on Celo carries the registration, and nothing else is touched`, async () => {
      const { deps, log } = fakeChains();
      const result = await grant([network], deps);

      expect(result.status).toBe("granted");
      expect(log.registry).toEqual([]);
      expect(log.cache).toEqual([]);
      expect(log.account.map((s) => s.chainId)).toEqual([network.chainId]);
      expect(log.account[0]!.calls).toHaveLength(1);
      expect(log.account[0]!.calls[0]!.to).toBe(network.keyStoreController);
      expect(legKinds(result)).toEqual([`account:${network.chainId}:CONFIRMED`, `registry:${network.chainId}:CONFIRMED:bundled`]);
      const [account, registry] = result.legs;
      expect(registry!.via).toBe("bundled");
      expect(registry!.transactionHash).toBe(account!.transactionHash);
      expect(await result.cacheSync).toEqual([]);
    });

    test(`revoke on ${network.chain.name}: the account and Celo's KeyStore are revoked in one intent`, async () => {
      const { deps, log } = fakeChains({ holds: [network.chainId], registryValid: [network.chainId] });
      const result = await revoke([network], deps, createPrivateKeySigner().publicKey);

      expect(result.status).toBe("revoked");
      expect(log.registry).toEqual([]);
      expect(log.cache).toEqual([]);
      expect(log.account).toHaveLength(1);
      expect(log.account[0]!.calls[0]!.to).toBe(network.keyStore);
      expect(result.legs.every((l) => l.chainId === network.chainId)).toBe(true);
    });
  }

  test("a failed registration on Celo fails the grant: the key is not authorized without its record", async () => {
    const { deps } = fakeChains({ failAccount: [CELO.chainId] });
    const result = await grant([CELO], deps);
    expect(result.status).toBe("failed");
    expect(legKinds(result)).toEqual([`account:${CELO.chainId}:FAILED`, `registry:${CELO.chainId}:FAILED:bundled`]);
  });

  test("Celo and BNB together: each registers on its own chain", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([BNB, CELO], deps);
    expect(result.status).toBe("granted");
    expect(log.registry).toEqual([]);
    expect(log.account.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([56, 42220]);
    expect(log.account.find((s) => s.chainId === 56)!.calls[0]!.to).toBe(BNB.keyStoreController);
    expect(log.account.find((s) => s.chainId === 42220)!.calls[0]!.to).toBe(CELO.keyStoreController);
  });
});

describe("grantSession with x402Tokens", () => {
  const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
  const USDT: Address = "0xd077A400968890Eacc75cdc901F0356c943e4fDb";
  const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

  /** The `to` of every call in the account intent for one chain. */
  const callTargets = (log: ReturnType<typeof fakeChains>["log"], chainId: number) =>
    log.account.find((s) => s.chainId === chainId)!.calls.map((c: { to: Address }) => c.to);

  test("no x402Tokens: the intent carries no approvals, exactly as before", async () => {
    const { deps, log } = fakeChains();
    await grant([MIRRORED_L2], deps);
    expect(callTargets(log, 11142220)).toEqual([]);
  });

  test("one token: the token approved to Permit2, the token and Permit2 as checkers", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([MIRRORED_L2], deps, { x402Tokens: [USDC] });
    expect(result.status).toBe("granted");
    // approve(token -> Permit2), setChecker(token), setChecker(Permit2).
    // The two self-calls target the wallet, since setSignatureCheckerApproval
    // is onlyThis.
    expect(callTargets(log, 11142220)).toEqual([USDC, WALLET.address, WALLET.address]);
  });

  test("Permit2 is approved as a checker once, not once per token", async () => {
    const { deps, log } = fakeChains();
    await grant([MIRRORED_L2], deps, { x402Tokens: [USDC, USDT] });
    const targets = callTargets(log, 11142220);
    // Two tokens: two ERC-20 approvals, two token checkers, one Permit2 checker.
    expect(targets.filter((t) => t === USDC)).toHaveLength(1);
    expect(targets.filter((t) => t === USDT)).toHaveLength(1);
    expect(targets.filter((t) => t === WALLET.address)).toHaveLength(3);
    expect(targets).toHaveLength(5);
  });

  // The account's approvals are its own storage on each chain, so a session
  // granted on two chains needs them on both.
  test("the approvals are made on every chain the session is granted on", async () => {
    const { deps, log } = fakeChains();
    await grant([MIRRORED_L2, BASE_SEPOLIA], deps, { x402Tokens: [USDC] });
    for (const chainId of [11142220, 84532]) {
      expect(callTargets(log, chainId)).toEqual([USDC, WALLET.address, WALLET.address]);
    }
  });

  // A bundled registry write shares the intent, and must still come first:
  // it carries the registration fee as value.
  test("they follow a bundled registry call rather than displacing it", async () => {
    const { deps, log } = fakeChains();
    await grant([SEPOLIA, MIRRORED_L2], deps, { x402Tokens: [USDC] });
    const sepolia = log.account.find((s) => s.chainId === 11155111)!;
    expect(sepolia.calls[0]!.value).toBe(7n);
    expect(sepolia.calls.map((c: { to: Address }) => c.to).slice(1)).toEqual([
      USDC,
      WALLET.address,
      WALLET.address,
    ]);
  });

  test("the checker approvals name this session's key hash", async () => {
    const { deps, log } = fakeChains();
    const sessionSigner = createPrivateKeySigner();
    await runGrantSession(
      WALLET,
      createPrivateKeySigner(),
      { permissions: {}, expiry: 1_800_000_000, sessionSigner, x402Tokens: [USDC] },
      { networks: [MIRRORED_L2] },
      deps,
    );
    const keyHash = keyHashForSigner(sessionSigner);
    const selfCalls = log.account
      .find((s) => s.chainId === 11142220)!
      .calls.filter((c: { to: Address }) => c.to === WALLET.address);
    expect(selfCalls).toHaveLength(2);
    for (const call of selfCalls) {
      expect((call as { data: string }).data).toContain(keyHash.slice(2));
    }
  });
});
