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
} = {}) {
  const log = {
    account: [] as Submitted[],
    registry: [] as Submitted[],
    cache: [] as { chainId: number; afterL1Block: bigint | undefined }[],
    order: [] as string[],
  };
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
      await tick();
      log.order.push(`account:${n.chainId}`);
      if (has(script.failAccount, n.chainId)) return { status: "FAILED", reason: "relay status FAILED" };
      return {
        status: "CONFIRMED",
        transactionHash: `0x${n.chainId.toString(16).padStart(64, "0")}` as Hex,
        ...(args.needBlockNumber ? { blockNumber: ++block } : {}),
      };
    },
    async submitRegistry(r, args) {
      log.registry.push({ chainId: r.chainId, calls: args.calls, args });
      await tick();
      log.order.push(`registry:${r.chainId}`);
      const via = r.relayUrl ? "relay" : "eoa";
      if (has(script.failRegistry, r.chainId)) return { via, status: "FAILED", reason: "reverted" };
      return { via, status: "CONFIRMED", blockNumber: ++block };
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
  return { deps, log };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

function revoke(networks: NetworkConfig[], deps: SessionLegDeps, key: Session | Hex = createPrivateKeySigner().publicKey) {
  return runRevokeSession(WALLET, createPrivateKeySigner(), key, { networks }, deps);
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
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA], deps);

    expect(log.account.map((s) => s.chainId)).toEqual([11142220]);
    expect(result.status).toBe("revoked");
  });

  test("nothing held and nothing registered is already revoked, with no writes", async () => {
    const { deps, log } = fakeChains();
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA, BNB], deps);

    expect(log.account).toEqual([]);
    expect(log.registry).toEqual([]);
    expect(log.cache).toEqual([]);
    expect(result.status).toBe("revoked");
  });

  test("an L2 with no cache configured adds no leg when nothing on it needs proving", async () => {
    const { deps } = fakeChains({ holds: [56], registryValid: [56] });
    const result = await revoke([BNB, ETHEREUM, CELO], deps);

    expect(result.legs.some((l) => l.chainId === 42220)).toBe(false);
    expect(result.status).toBe("revoked");
  });

  test("an unreadable account is a failed leg, never a clean chain", async () => {
    const { deps } = fakeChains({ readErrorAccount: [84532] });
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA], deps);

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
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA], deps, key);

    expect(log.registry.map((s) => s.chainId)).toEqual([11155111]);
    const { functionName, args } = decodeFunctionData({ abi: REVOKE_KEY_ABI, data: log.registry[0]!.calls[0]!.data! });
    expect(functionName).toBe("revokeKey");
    expect(log.registry[0]!.calls[0]!.to).toBe(SEPOLIA.keyStore);
    expect(args[1]).toBe(keccak256(key));
    // Account legs on the L2s carry no registry call.
    expect(log.account.every((s) => s.calls.length === 0)).toBe(true);
    expect(legKinds(result)).toEqual([
      "account:11142220:CONFIRMED",
      "account:84532:CONFIRMED",
      "registry:11155111:CONFIRMED:eoa",
      "cache:11142220:CONFIRMED",
      "cache:84532:CONFIRMED",
    ]);
    expect(result.status).toBe("revoked");
  });

  test("no registry leg when readIsValidKey is false", async () => {
    const { deps, log } = fakeChains({ holds: [11142220] });
    const result = await revoke([CELO_SEPOLIA], deps);

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
      ...CELO,
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
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    expect(log.account.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
    expect(log.registry).toHaveLength(1);
    expect(log.cache.map((c) => c.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
  });

  test("a failed registry leg makes the revoke failed and skips the cache proofs behind it", async () => {
    const { deps, log } = fakeChains({ holds: [11142220], registryValid: [11155111], failRegistry: [11155111] });
    const result = await revoke([CELO_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    expect(log.cache).toEqual([]);
    const cache = result.legs.find((l) => l.kind === "cache")!;
    expect(cache.status).toBe("SKIPPED");
  });

  test("a failed cache leg makes the revoke failed", async () => {
    const { deps } = fakeChains({ holds: [84532], registryValid: [11155111], failCache: [84532] });
    const result = await revoke([BASE_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    expect(result.legs.find((l) => l.kind === "cache")!.status).toBe("FAILED");
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
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA], deps);

    expect(log.account).toEqual([]);
    expect(log.registry).toEqual([]);
    expect(log.cache).toEqual([{ chainId: 84532, afterL1Block: undefined }]);
    expect(result.status).toBe("revoked");
  });

  test("after a failed account leg, a retry acts only on that chain", async () => {
    const { deps, log } = fakeChains({ holds: [11142220] });
    const result = await revoke([CELO_SEPOLIA, BASE_SEPOLIA], deps);

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
    await revoke([CELO_SEPOLIA], deps, session);
    expect(log.account[0]!.args.revokeKeys[0].type).toBe("webauthn-p256");
  });
});

describe("grantSession everywhere", () => {
  test("one registry write on Sepolia, then an account leg and a cache proof on each L2", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([CELO_SEPOLIA, BASE_SEPOLIA], deps);

    expect(log.registry.map((s) => s.chainId)).toEqual([11155111]);
    expect(log.registry[0]!.calls[0]!.value).toBe(7n);
    expect(log.account.map((s) => s.chainId).sort((a, b) => a - b)).toEqual([84532, 11142220]);
    expect(log.account.every((s) => s.calls.length === 0 && s.args.authorizeKeys.length === 1)).toBe(true);
    // The registry write lands before any account authorization behind it.
    expect(log.order.indexOf("registry:11155111")).toBeLessThan(log.order.indexOf("account:11142220"));
    const registryBlock = result.legs.find((l) => l.kind === "registry")!.blockNumber;
    expect(log.cache).toEqual([
      { chainId: 11142220, afterL1Block: registryBlock },
      { chainId: 84532, afterL1Block: registryBlock },
    ]);
    expect(result.status).toBe("granted");
    expect(result.keyId).toBe(keccak256(result.publicKey));
  });

  test("a key already valid in the registry is not written again", async () => {
    const { deps, log } = fakeChains({ registryValid: [11155111] });
    const result = await grant([CELO_SEPOLIA, BASE_SEPOLIA], deps);

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

  test("a failed registry write fails the grant and skips the authorizations behind it", async () => {
    const { deps, log } = fakeChains({ failRegistry: [11155111] });
    const result = await grant([CELO_SEPOLIA, BASE_SEPOLIA, BNB], deps);

    expect(result.status).toBe("failed");
    expect(log.account.map((s) => s.chainId)).toEqual([56]);
    expect(result.legs.filter((l) => l.kind === "account" && l.status === "SKIPPED").map((l) => l.chainId)).toEqual([
      11142220, 84532,
    ]);
  });

  test("a failed account leg fails the grant; the other chain still completes", async () => {
    const { deps, log } = fakeChains({ failAccount: [84532] });
    const result = await grant([CELO_SEPOLIA, BASE_SEPOLIA], deps);

    expect(result.status).toBe("failed");
    expect(log.cache.map((c) => c.chainId)).toEqual([11142220]);
  });

  test("register: false writes no registry and proves no cache", async () => {
    const { deps, log } = fakeChains();
    const result = await grant([CELO_SEPOLIA], deps, { register: false });

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
    const result = await grant([CELO_SEPOLIA, BASE_SEPOLIA], deps);
    const keys = log.account.map((s) => s.args.authorizeKeys[0].publicKey);
    expect(new Set(keys)).toEqual(new Set([result.publicKey]));
  });
});
