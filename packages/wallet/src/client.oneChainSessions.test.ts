/**
 * client.grantSession and client.revokeSession as a caller sees them: which
 * chains a call reaches, what it returns, and when it throws.
 *
 * A grant goes to one chain unless `chainIds` says otherwise, and a one-chain
 * call behaves the way it did in 0.9.0: it returns `transactionHash` and
 * throws when the account on that chain did not take the change. The chain
 * I/O is a fake SessionLegDeps, so no module is mocked here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { createClientWith } from "./client.js";
import { BASE_SEPOLIA, BNB, CELO_SEPOLIA, ETHEREUM, SEPOLIA, type NetworkConfig } from "./config.js";
import { SessionRevokeError } from "./internal/oneChain.js";
import { realSessionLegDeps, type IntentOutcome, type SessionLegDeps } from "./internal/sessionLegs.js";
import type { CacheSyncReport, GrantSessionStatus } from "./internal/sessions.js";
import { createPrivateKeySigner } from "./internal/signer.js";

const WALLET = { address: "0x1111111111111111111111111111111111111111" as Address };
const hashOn = (chainId: number) => `0x${chainId.toString(16).padStart(64, "0")}` as Hex;
const tick = () => new Promise((r) => setTimeout(r, 1));

type Script = {
  /** What the account intent on a chain returns. Default: CONFIRMED with `hashOn(chainId)`. */
  account?: Record<number, IntentOutcome>;
  /** What the registry write on a registry chain returns. Default: CONFIRMED. */
  registry?: Record<number, IntentOutcome>;
  /** Registry chains whose `isValidKey` read throws this. */
  registryReadError?: Record<number, Error>;
  /** Registry chains that already list the key. */
  registryValid?: number[];
  /** Chains whose account holds the key (revoke discovery). */
  holds?: number[];
  /** Chains whose account read throws this (revoke discovery). */
  accountReadError?: Record<number, Error>;
};

/** A scripted set of chains and a log of every read and write made against them. */
function fakeChains(script: Script = {}) {
  const log = {
    account: [] as number[],
    registry: [] as number[],
    cache: [] as number[],
    /** Every chain any dep was asked about, reads included. */
    touched: new Set<number>(),
  };
  let block = 100n;
  const deps: SessionLegDeps = {
    async accountHasKey(n) {
      log.touched.add(n.chainId);
      const err = script.accountReadError?.[n.chainId];
      if (err) throw err;
      return (script.holds ?? []).includes(n.chainId);
    },
    async isValidRegistryKey(r) {
      log.touched.add(r.chainId);
      const err = script.registryReadError?.[r.chainId];
      if (err) throw err;
      return (script.registryValid ?? []).includes(r.chainId);
    },
    async registrationFee(r) {
      log.touched.add(r.chainId);
      return 7n;
    },
    async cacheHoldsLiveKey(n) {
      log.touched.add(n.chainId);
      return false;
    },
    async submitAccountIntent(n, args) {
      log.touched.add(n.chainId);
      log.account.push(n.chainId);
      await tick();
      const scripted = script.account?.[n.chainId];
      if (scripted) return scripted;
      return {
        status: "CONFIRMED",
        relayStatus: "CONFIRMED",
        statusCode: 200,
        callsId: "0xca11" as Hex,
        transactionHash: hashOn(n.chainId),
        ...(args.needBlockNumber ? { blockNumber: ++block } : {}),
      };
    },
    async submitRegistry(r) {
      log.touched.add(r.chainId);
      log.registry.push(r.chainId);
      await tick();
      const via = r.relayUrl ? ("relay" as const) : ("eoa" as const);
      const scripted = script.registry?.[r.chainId];
      if (scripted) return { via, ...scripted };
      return { via, status: "CONFIRMED", blockNumber: ++block, transactionHash: hashOn(r.chainId) };
    },
    async proveIntoCache(_w, _a, _pk, n): Promise<CacheSyncReport> {
      log.touched.add(n.chainId);
      log.cache.push(n.chainId);
      return { chainId: n.chainId, status: "CONFIRMED" };
    },
    async waitForKeyVisible() {},
    async sleep() {},
  };
  return { deps, log };
}

function clientOf(chains: NetworkConfig[], script: Script = {}, defaultChainId?: number) {
  const { deps, log } = fakeChains(script);
  const client = createClientWith(
    { chains, ...(defaultChainId !== undefined ? { defaultChainId } : {}) },
    { sessionLegs: deps },
  );
  return { client, log };
}

/** The arguments of a grant, as a 0.9.0 caller writes them. */
function grantArgs() {
  return {
    wallet: WALLET,
    signer: createPrivateKeySigner(),
    sessionSigner: createPrivateKeySigner(),
    permissions: {},
    expiry: 1_800_000_000,
  };
}

function revokeArgs() {
  return { wallet: WALLET, signer: createPrivateKeySigner(), session: createPrivateKeySigner().publicKey };
}

/** What a call threw, or undefined when it resolved. */
async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** A relay failure the way the SDK throws one: a plain sentence wrapping the relay's own error. */
function relayError(): Error {
  const rpc = new Error("Invalid parameters were provided to the RPC method: the quote has expired");
  const transport = new Error("RPC Request failed.", { cause: rpc });
  return new Error("The relay did not accept the request.", { cause: transport });
}

const legKinds = (r: { legs: { chainId: number; kind: string; status: string }[] }) =>
  r.legs.map((l) => `${l.kind}:${l.chainId}:${l.status}`);

describe("grantSession picks one chain", () => {
  test("with no chain option, the grant goes to the client's default chain only", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM, CELO_SEPOLIA]);
    const session = await client.grantSession(grantArgs());

    expect(log.account).toEqual([BNB.chainId]);
    expect(legKinds(session)).toEqual(["account:56:CONFIRMED", "registry:56:CONFIRMED"]);
    expect(session.status).toBe("granted");
  });

  test("the default chain is the client's defaultChainId, not the first chain", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM], {}, ETHEREUM.chainId);
    await client.grantSession(grantArgs());

    expect(log.account).toEqual([ETHEREUM.chainId]);
  });

  test("chainId names the one chain", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM, CELO_SEPOLIA]);
    const session = await client.grantSession({ ...grantArgs(), chainId: ETHEREUM.chainId });

    expect(log.account).toEqual([ETHEREUM.chainId]);
    expect(session.legs.every((l) => l.chainId === ETHEREUM.chainId)).toBe(true);
  });

  test("the other chains of the client are not written to or even read", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM, CELO_SEPOLIA, BASE_SEPOLIA]);
    await client.grantSession({ ...grantArgs(), chainId: BNB.chainId });

    expect(log.account).toEqual([BNB.chainId]);
    expect(log.registry).toEqual([]);
    expect(log.cache).toEqual([]);
    expect([...log.touched]).toEqual([BNB.chainId]);
  });

  test("a one-chain grant on a cached network touches that network and its registry chain, nothing else", async () => {
    const { client, log } = clientOf([BNB, CELO_SEPOLIA, BASE_SEPOLIA]);
    const session = await client.grantSession({ ...grantArgs(), chainId: CELO_SEPOLIA.chainId });
    await session.registration;
    await session.cacheSync;

    expect(log.account).toEqual([CELO_SEPOLIA.chainId]);
    expect(log.registry).toEqual([SEPOLIA.chainId]);
    expect([...log.touched].sort((a, b) => a - b)).toEqual([CELO_SEPOLIA.chainId, SEPOLIA.chainId]);
  });

  test("chainId and chainIds together are refused before anything is sent", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM]);
    const both = { ...grantArgs(), chainId: BNB.chainId, chainIds: [BNB.chainId] } as any;

    await expect(client.grantSession(both)).rejects.toThrow(/`chainId`.*`chainIds`.*not both/);
    await expect(client.quoteGrantSession(both)).rejects.toThrow(/not both/);
    expect(log.touched.size).toBe(0);
  });

  test("a chain the client was not created with is refused", async () => {
    const { client, log } = clientOf([BNB]);

    await expect(client.grantSession({ ...grantArgs(), chainId: 1 })).rejects.toThrow(/Chain 1 is not configured/);
    expect(log.touched.size).toBe(0);
  });
});

describe("a one-chain grant that went through", () => {
  test("carries the account leg's transaction hash", async () => {
    const { client } = clientOf([BNB, ETHEREUM]);
    const session = await client.grantSession({ ...grantArgs(), chainId: BNB.chainId });

    expect(session.transactionHash).toBe(hashOn(BNB.chainId));
    expect(session.legs.find((l) => l.kind === "account")!.transactionHash).toBe(session.transactionHash!);
  });

  test("keeps everything the multi-chain result has", async () => {
    const { client } = clientOf([CELO_SEPOLIA]);
    const args = grantArgs();
    const session = await client.grantSession(args);

    expect(session.status).toBe("granted");
    expect(session.publicKey).toBe(args.sessionSigner.publicKey);
    expect(session.walletAddress).toBe(WALLET.address);
    expect(session.keyId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(session.keyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(session.transactionHash).toBe(hashOn(CELO_SEPOLIA.chainId));
    expect((await session.registration).map((l) => l.status)).toEqual(["CONFIRMED"]);
    expect((await session.cacheSync).map((l) => l.status)).toEqual(["CONFIRMED"]);
  });

  test("a confirmed leg the relay gave no hash for returns without one, as in 0.9.0", async () => {
    const { client } = clientOf([BNB], { account: { [BNB.chainId]: { status: "CONFIRMED", blockNumber: 5n } } });
    const session = await client.grantSession(grantArgs());

    expect(session.status).toBe("granted");
    expect("transactionHash" in session).toBe(false);
  });
});

describe("a one-chain grant whose account leg did not confirm throws", () => {
  test("the error thrown underneath comes back as it was, cause chain intact", async () => {
    const original = relayError();
    const { client } = clientOf([BNB], {
      account: { [BNB.chainId]: { status: "FAILED", reason: original.message, error: original } },
    });

    const thrown = await thrownBy(() => client.grantSession(grantArgs()));

    expect(thrown).toBe(original);
    expect(((thrown as Error).cause as Error).message).toBe("RPC Request failed.");
    expect((((thrown as Error).cause as Error).cause as Error).message).toMatch(/quote has expired/);
  });

  test("a relay status of PENDING throws the 0.9.0 message, relay code included", async () => {
    const { client } = clientOf([BNB], {
      account: {
        [BNB.chainId]: { status: "FAILED", relayStatus: "PENDING", statusCode: 100, reason: "relay status PENDING (code 100)" },
      },
    });

    const thrown = (await thrownBy(() => client.grantSession(grantArgs()))) as Error;

    expect(thrown.message).toBe("Session grant did not confirm: status=PENDING (relay code 100)");
  });

  test("a relay status of FAILED throws the 0.9.0 message", async () => {
    const { client } = clientOf([BNB], {
      account: { [BNB.chainId]: { status: "FAILED", relayStatus: "FAILED", statusCode: 300 } },
    });

    const thrown = (await thrownBy(() => client.grantSession(grantArgs()))) as Error;

    expect(thrown.message).toBe("Session grant did not confirm: status=FAILED (relay code 300)");
  });

  test("a relay status with no code leaves the code out", async () => {
    const { client } = clientOf([BNB], { account: { [BNB.chainId]: { status: "FAILED", relayStatus: "PENDING" } } });

    const thrown = (await thrownBy(() => client.grantSession(grantArgs()))) as Error;

    expect(thrown.message).toBe("Session grant did not confirm: status=PENDING");
  });

  test("a failure with neither an error nor a relay status still throws, with its reason", async () => {
    const { client } = clientOf([BNB], { account: { [BNB.chainId]: { status: "FAILED", reason: "reverted" } } });

    const thrown = (await thrownBy(() => client.grantSession(grantArgs()))) as Error;

    expect(thrown.message).toBe("Session grant did not confirm: status=FAILED: reverted");
  });

  test("a registry that cannot be read on a local-registry chain throws the read's own error: nothing was authorized", async () => {
    const original = new Error("HTTP request failed", { cause: new Error("ECONNRESET") });
    const { client, log } = clientOf([BNB], { registryReadError: { [BNB.chainId]: original } });

    const thrown = await thrownBy(() => client.grantSession(grantArgs()));

    expect(thrown).toBe(original);
    expect(log.account).toEqual([]);
  });

  test("on a cached network a failed authorization throws, and the KeyStore write is never attempted", async () => {
    const original = relayError();
    const { client, log } = clientOf([CELO_SEPOLIA], {
      account: { [CELO_SEPOLIA.chainId]: { status: "FAILED", reason: original.message, error: original } },
    });

    expect(await thrownBy(() => client.grantSession(grantArgs()))).toBe(original);
    await tick();
    expect(log.registry).toEqual([]);
  });
});

describe("a one-chain grant with a live key never throws", () => {
  test("cached network: a background registration that fails is reported, not thrown", async () => {
    const { client } = clientOf([CELO_SEPOLIA], {
      registry: { [SEPOLIA.chainId]: { status: "FAILED", reason: "the relay could not source the funds" } },
    });
    const seen: { status: GrantSessionStatus; reason?: string }[] = [];

    const session = await client.grantSession({
      ...grantArgs(),
      onStatus: (status, detail) => seen.push({ status, ...(detail?.reason ? { reason: detail.reason } : {}) }),
    });

    // At return the key is live and the write is still running.
    expect(session.transactionHash).toBe(hashOn(CELO_SEPOLIA.chainId));
    expect(legKinds(session)).toEqual(["account:11142220:CONFIRMED", "registry:11155111:PENDING", "cache:11142220:PENDING"]);

    const registration = await session.registration;
    expect(registration.map((l) => `${l.chainId}:${l.status}:${l.reason}`)).toEqual([
      "11155111:FAILED:the relay could not source the funds",
    ]);
    expect(seen).toContainEqual({ status: "registry-write-failed", reason: "the relay could not source the funds" });
    expect((await session.cacheSync).map((l) => l.status)).toEqual(["SKIPPED"]);
  });

  test("cached network: the same holds when the caller waits for the proofs", async () => {
    const { client } = clientOf([CELO_SEPOLIA], {
      registry: { [SEPOLIA.chainId]: { status: "FAILED", reason: "reverted" } },
    });

    const session = await client.grantSession({ ...grantArgs(), populateCache: "await" });

    expect(session.status).toBe("failed");
    expect(session.transactionHash).toBe(hashOn(CELO_SEPOLIA.chainId));
    expect(legKinds(session)).toEqual(["account:11142220:CONFIRMED", "registry:11155111:FAILED", "cache:11142220:SKIPPED"]);
  });

  test("cached network: a registry that cannot be read does not throw, the key is on the account", async () => {
    const { client, log } = clientOf([CELO_SEPOLIA], {
      registryReadError: { [SEPOLIA.chainId]: new Error("HTTP request failed") },
    });

    const session = await client.grantSession(grantArgs());

    expect(log.account).toEqual([CELO_SEPOLIA.chainId]);
    expect(session.transactionHash).toBe(hashOn(CELO_SEPOLIA.chainId));
    expect(session.status).toBe("failed");
    const registry = session.legs.find((l) => l.kind === "registry")!;
    expect(registry.status).toBe("FAILED");
    expect(registry.reason).toBe("could not read the registry: HTTP request failed");
    expect((await session.registration).map((l) => l.status)).toEqual(["FAILED"]);
  });
});

describe("chainIds keeps the multi-chain behaviour", () => {
  test("it grants on each chain listed and never throws for a failed one", async () => {
    const original = relayError();
    const { client, log } = clientOf([BNB, ETHEREUM, CELO_SEPOLIA], {
      account: { [ETHEREUM.chainId]: { status: "FAILED", reason: original.message, error: original } },
    });

    const session = await client.grantSession({ ...grantArgs(), chainIds: [BNB.chainId, ETHEREUM.chainId] });

    expect(log.account.sort((a, b) => a - b)).toEqual([ETHEREUM.chainId, BNB.chainId]);
    expect(session.status).toBe("failed");
    expect(session.legs.find((l) => l.kind === "account" && l.chainId === ETHEREUM.chainId)!.status).toBe("FAILED");
    expect(session.legs.find((l) => l.kind === "account" && l.chainId === BNB.chainId)!.status).toBe("CONFIRMED");
    expect("transactionHash" in session).toBe(false);
  });

  test("a single chain in chainIds is still the multi-chain form: a failed leg is a status, not a throw", async () => {
    const { client } = clientOf([BNB], {
      account: { [BNB.chainId]: { status: "FAILED", relayStatus: "PENDING", statusCode: 100 } },
    });

    const session = await client.grantSession({ ...grantArgs(), chainIds: [BNB.chainId] });

    expect(session.status).toBe("failed");
    expect(legKinds(session)).toEqual(["account:56:FAILED", "registry:56:FAILED"]);
  });

  test("the legs carry no error object: a leg stays a plain value", async () => {
    const original = relayError();
    const { client } = clientOf([BNB], {
      account: { [BNB.chainId]: { status: "FAILED", reason: original.message, error: original } },
    });

    const session = await client.grantSession({ ...grantArgs(), chainIds: [BNB.chainId] });

    expect(session.legs[0]).toEqual({ chainId: 56, kind: "account", status: "FAILED", reason: original.message });
  });
});

describe("quoteGrantSession never throws for a failed leg", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the reads that make a one-chain grant throw leave the quote a quote", async () => {
    // No relay or RPC answers: any leg the quote does try comes back unpriced.
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const original = new Error("HTTP request failed");
    const { client } = clientOf([BNB], { registryReadError: { [BNB.chainId]: original } });

    expect(await thrownBy(() => client.grantSession(grantArgs()))).toBe(original);
    const quote = await client.quoteGrantSession(grantArgs());

    expect(Array.isArray(quote.lines)).toBe(true);
    expect(quote.lines.every((l) => l.chainId === BNB.chainId)).toBe(true);
  });

  test("a leg the relay will not price is a line with a reason", async () => {
    // The relay is unreachable; the chain's RPC answers balance reads with zero.
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const answer = (call: { id?: number; method?: string }) => {
        if (call.method !== "eth_getBalance") throw new Error("offline");
        return { jsonrpc: "2.0", id: call.id, result: "0x0" };
      };
      const payload = Array.isArray(body) ? body.map(answer) : answer(body);
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { client } = clientOf([BNB, ETHEREUM]);

    const quote = await client.quoteGrantSession({ ...grantArgs(), chainId: BNB.chainId });

    expect(quote.complete).toBe(false);
    expect(quote.lines.length).toBeGreaterThan(0);
    expect(quote.lines.every((l) => l.chainId === BNB.chainId)).toBe(true);
    expect(quote.lines.every((l) => l.fee === undefined && typeof l.reason === "string")).toBe(true);
  }, 60_000);
});

describe("revokeSession answers for one chain", () => {
  test("it returns the named chain's account transaction", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM], { holds: [BNB.chainId, ETHEREUM.chainId], registryValid: [56, 1] });

    const res = await client.revokeSession({ ...revokeArgs(), chainId: ETHEREUM.chainId });

    expect(res.transactionHash).toBe(hashOn(ETHEREUM.chainId));
    expect(res.status).toBe("revoked");
    expect(res.statusCode).toBe(200);
    expect(res.callsId).toBe("0xca11");
    // The revoke itself still reaches every chain holding the key.
    expect(log.account.sort((a, b) => a - b)).toEqual([ETHEREUM.chainId, BNB.chainId]);
  });

  test("with no chainId it answers for the client's default chain", async () => {
    const { client } = clientOf([BNB, ETHEREUM], { holds: [BNB.chainId, ETHEREUM.chainId] }, ETHEREUM.chainId);

    const res = await client.revokeSession(revokeArgs());

    expect(res.transactionHash).toBe(hashOn(ETHEREUM.chainId));
  });

  test("it throws when the named chain's account leg failed, and never reads as a success", async () => {
    const { client } = clientOf([BNB, ETHEREUM], {
      holds: [BNB.chainId, ETHEREUM.chainId],
      account: { [BNB.chainId]: { status: "FAILED", relayStatus: "FAILED", statusCode: 300 } },
    });

    const thrown = await thrownBy(() => client.revokeSession({ ...revokeArgs(), chainId: BNB.chainId }));

    expect(thrown).toBeInstanceOf(SessionRevokeError);
    const err = thrown as SessionRevokeError;
    expect(err.message).toContain("Session revoke did not confirm on chain 56");
    expect(err.message).toContain("status=FAILED (relay code 300)");
    expect(err.chainId).toBe(BNB.chainId);
    // The whole outcome rides on the error: Ethereum did revoke.
    expect(err.result.status).toBe("failed");
    expect(legKinds(err.result).filter((l) => l.startsWith("account"))).toEqual(["account:56:FAILED", "account:1:CONFIRMED"]);
  });

  test("a relay that never confirmed (PENDING) throws too", async () => {
    const { client } = clientOf([BNB], {
      holds: [BNB.chainId],
      account: { [BNB.chainId]: { status: "FAILED", relayStatus: "PENDING", statusCode: 100 } },
    });

    const thrown = (await thrownBy(() => client.revokeSession(revokeArgs()))) as Error;

    expect(thrown.message).toContain("status=PENDING (relay code 100)");
  });

  test("a registry revoke bundled into the failed account intent is one failure, said once", async () => {
    const { client } = clientOf([BNB], {
      holds: [BNB.chainId],
      registryValid: [BNB.chainId],
      account: { [BNB.chainId]: { status: "FAILED", relayStatus: "FAILED", statusCode: 300 } },
    });

    const thrown = (await thrownBy(() => client.revokeSession(revokeArgs()))) as SessionRevokeError;

    expect(legKinds(thrown.result)).toEqual(["account:56:FAILED", "registry:56:FAILED"]);
    expect(thrown.message).toBe(
      "Session revoke did not confirm on chain 56 (account leg on chain 56: status=FAILED (relay code 300)). " +
        "Calling revokeSession again is safe: it only acts on what is still pending.",
    );
  });

  test("the error thrown underneath is the cause", async () => {
    const original = relayError();
    const { client } = clientOf([BNB], {
      holds: [BNB.chainId],
      account: { [BNB.chainId]: { status: "FAILED", reason: original.message, error: original } },
    });

    const thrown = (await thrownBy(() => client.revokeSession(revokeArgs()))) as Error;

    expect(thrown).toBeInstanceOf(SessionRevokeError);
    expect(thrown.cause).toBe(original);
    expect(thrown.message).toContain(original.message);
  });

  test("it throws when the named chain could not be read at all", async () => {
    const original = new Error("HTTP request failed");
    const { client } = clientOf([BNB, ETHEREUM], {
      holds: [ETHEREUM.chainId],
      accountReadError: { [BNB.chainId]: original },
    });

    const thrown = (await thrownBy(() => client.revokeSession({ ...revokeArgs(), chainId: BNB.chainId }))) as SessionRevokeError;

    expect(thrown).toBeInstanceOf(SessionRevokeError);
    expect(thrown.cause).toBe(original);
    expect(thrown.result.legs.find((l) => l.chainId === BNB.chainId)!.unread).toBe(true);
  });

  test("it throws when the named chain's registry leg failed, even with the account revoked", async () => {
    const { client } = clientOf([CELO_SEPOLIA], {
      holds: [CELO_SEPOLIA.chainId],
      registryValid: [SEPOLIA.chainId],
      registry: { [SEPOLIA.chainId]: { status: "FAILED", reason: "reverted" } },
    });

    const thrown = (await thrownBy(() => client.revokeSession(revokeArgs()))) as SessionRevokeError;

    expect(thrown).toBeInstanceOf(SessionRevokeError);
    expect(thrown.message).toContain("registry leg on chain 11155111: status=FAILED: reverted");
    expect(thrown.result.legs.find((l) => l.kind === "account")!.status).toBe("CONFIRMED");
  });

  test("a failure on another chain does not throw: it is in status and legs", async () => {
    const { client } = clientOf([BNB, ETHEREUM], {
      holds: [BNB.chainId],
      accountReadError: { [ETHEREUM.chainId]: new Error("HTTP request failed") },
    });

    const res = await client.revokeSession({ ...revokeArgs(), chainId: BNB.chainId });

    expect(res.transactionHash).toBe(hashOn(BNB.chainId));
    expect(res.status).toBe("failed");
    const other = res.legs.find((l) => l.chainId === ETHEREUM.chainId)!;
    expect(other.status).toBe("FAILED");
    expect(other.unread).toBe(true);
  });

  test("a key the named chain does not hold is already revoked there: no hash, no throw", async () => {
    const { client, log } = clientOf([BNB, ETHEREUM]);

    const res = await client.revokeSession({ ...revokeArgs(), chainId: BNB.chainId });

    expect(res.status).toBe("revoked");
    expect("transactionHash" in res).toBe(false);
    expect(log.account).toEqual([]);
  });

  test("a chain the client was not created with is refused", async () => {
    const { client, log } = clientOf([BNB]);

    await expect(client.revokeSession({ ...revokeArgs(), chainId: 1 })).rejects.toThrow(/Chain 1 is not configured/);
    expect(log.touched.size).toBe(0);
  });
});

describe("the real chain I/O reports what the client needs", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("an account intent that throws keeps the thrown error on its outcome", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const admin = createPrivateKeySigner();

    const outcome = await realSessionLegDeps.submitAccountIntent(BNB, {
      wallet: WALLET,
      adminSigner: admin,
      calls: [],
    });

    expect(outcome.status).toBe("FAILED");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.reason).toBe((outcome.error as Error).message);
  }, 60_000);
});
