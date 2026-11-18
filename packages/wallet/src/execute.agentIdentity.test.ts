/**
 * A KeyStore registration never depends on ERC-8004.
 *
 * These drive the real `execute` over a mocked fetch that plays the relay AND
 * the chain, for a wallet doing its first admin action. They pin the three
 * things the rule is made of:
 *
 *   1. The transaction that sets the wallet up carries the KeyStore
 *      registration and nothing addressed to the agent registry.
 *   2. The agent registration is a second transaction, prepared only after the
 *      first one has been mined.
 *   3. Whatever the agent registry does (unreadable, refuses the registration,
 *      the relay rejects it), `execute` resolves with the same confirmed
 *      result and reports the rest in `agentIdentity`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, numberToHex, pad, toEventSelector, type Address, type Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { ERC8004_ADDRESSES } from "./erc8004.js";
import { execute } from "./execute.js";
import { laneNonce } from "./internal/appNonceLane.js";
import { clearFirstAction } from "./internal/firstActions.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./internal/fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const USER_CALL = { to: "0x2222222222222222222222222222222222222222" as Address, value: 0n, data: "0x" as Hex };
const REGISTRY = ERC8004_ADDRESSES[CELO_SEPOLIA.chainId]!.toLowerCase();
const KEYSTORE = CELO_SEPOLIA.keyStore.toLowerCase();
const CONTROLLER = CELO_SEPOLIA.keyStoreController.toLowerCase();
const GET_NONCE_SELECTOR = "0x3e1b0812";
const REGISTERED_TOPIC = toEventSelector("Registered(uint256,string,address)");
const AGENT_ID = 9001n;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Wire = {
  /** Keys the wallet has in the KeyStore before anything is sent. 0 is a new wallet. */
  keysBefore?: number;
  /** What the agent registry answers to "how many agents does this wallet own". */
  agentCount?: bigint | "unreadable";
  /** What happens to the agent registration once it is sent. */
  registration?: "confirms" | "reverts" | "relay-rejects";
};

/**
 * Plays the relay and the chain. The wallet's KeyStore entry appears when its
 * first bundle is mined, as it does on a chain. Every bundle is recorded with
 * the targets of its calls and how many bundles were mined when it was
 * prepared.
 */
function mockWire(wallet: Address, o: Wire = {}) {
  const bundles: { targets: string[]; minedWhenPrepared: number }[] = [];
  const pending: string[][] = [];
  let mined = 0;
  let registryReads = 0;
  const counted = new Set<string>();
  const owner = pad(wallet.toLowerCase() as Hex, { size: 32 });

  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
      const fail = (message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message } });
      if (req.method === "eth_call") {
        const to = String(req.params?.[0]?.to ?? "").toLowerCase();
        const data = String(req.params?.[0]?.data ?? "");
        if (to === KEYSTORE) {
          const keys = (o.keysBefore ?? 0) + (mined > 0 ? 1 : 0);
          return ok(encodeAbiParameters([{ type: "bytes32[]" }], [Array.from({ length: keys }, () => `0x${"01".repeat(32)}` as Hex)]));
        }
        if (to === CONTROLLER) return ok(encodeAbiParameters([{ type: "uint256" }], [10n ** 15n]));
        if (to === REGISTRY) {
          registryReads += 1;
          if (o.agentCount === "unreadable") return fail("execution reverted");
          return ok(encodeAbiParameters([{ type: "uint256" }], [o.agentCount ?? 0n]));
        }
        if (data.startsWith(GET_NONCE_SELECTOR)) {
          const lane = BigInt(`0x${data.slice(10)}`);
          return ok(numberToHex(laneNonce(lane, BigInt(mined)), { size: 32 }));
        }
        return ok("0x");
      }
      if (req.method === "eth_chainId") return ok(numberToHex(CELO_SEPOLIA.chainId));
      if (req.method === "wallet_getCapabilities") return ok({ [numberToHex(CELO_SEPOLIA.chainId)]: capabilities["0xaa044c"] });
      if (req.method === "wallet_getAssets") {
        return ok({ [numberToHex(CELO_SEPOLIA.chainId)]: [{ address: "native", balance: numberToHex(10n ** 18n), type: "native", metadata: null }] });
      }
      if (req.method === "wallet_prepareCalls") {
        const targets = ((req.params?.[0]?.calls ?? []) as { to: string }[]).map((c) => c.to.toLowerCase());
        if (targets.includes(REGISTRY) && o.registration === "relay-rejects") return fail("intent reverted: 0x");
        pending.push(targets);
        bundles.push({ targets, minedWhenPrepared: mined });
        return ok(prepared);
      }
      if (req.method === "wallet_sendPreparedCalls") return ok({ id: `0x${bundles.length.toString(16).padStart(2, "0")}` });
      if (req.method === "wallet_getCallsStatus") {
        const id = String(req.params?.[0]);
        const index = Number.parseInt(id.slice(2), 16) - 1;
        const isAgent = bundles[index]?.targets.includes(REGISTRY) ?? false;
        const receipt = (status: "0x1" | "0x0", logs: unknown[]) => ({
          chainId: numberToHex(CELO_SEPOLIA.chainId),
          transactionHash: `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`,
          status,
          blockNumber: "0x1",
          blockHash: `0x${"cd".repeat(32)}`,
          gasUsed: "0x1",
          logs,
        });
        if (isAgent && o.registration === "reverts") return ok({ id, status: 500, receipts: [receipt("0x0", [])] });
        if (!counted.has(id)) {
          counted.add(id);
          mined += 1;
        }
        const logs = isAgent
          ? [{ address: REGISTRY, data: "0x", topics: [REGISTERED_TOPIC, numberToHex(AGENT_ID, { size: 32 }), owner] }]
          : [];
        return ok({ id, status: 200, receipts: [receipt("0x1", logs)] });
      }
      throw new Error(`unexpected ${req.method}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;

  return { bundles, registryReads: () => registryReads };
}

let seq = 0;
/** A fresh wallet address per test, so one test's note cannot reach another. */
function freshWallet() {
  seq += 1;
  const wallet = { address: `0x${(0xa9e0000 + seq).toString(16).padStart(40, "0")}` as Address };
  clearFirstAction(CELO_SEPOLIA.chainId, wallet.address);
  return wallet;
}

describe("a new wallet's first action", () => {
  test("sets the wallet up in one transaction, then registers the agent in a second", async () => {
    const wallet = freshWallet();
    const wire = mockWire(wallet.address);
    const result = await execute(wallet, createPrivateKeySigner(), [USER_CALL], { network: CELO_SEPOLIA });

    expect(result.status).toBe("CONFIRMED");
    expect(result.agentIdentity).toEqual({
      status: "registered",
      chainId: CELO_SEPOLIA.chainId,
      registry: ERC8004_ADDRESSES[CELO_SEPOLIA.chainId]!,
      agentId: AGENT_ID.toString(),
      callsId: "0x02",
      transactionHash: `0x${"02".repeat(32)}`,
    });

    expect(wire.bundles).toHaveLength(2);
    const [setUp, agent] = wire.bundles;
    // 1. The set-up transaction: the KeyStore registration and the caller's own call. Nothing else.
    expect(setUp!.targets).toEqual([CONTROLLER, USER_CALL.to]);
    expect(setUp!.targets).not.toContain(REGISTRY);
    // 2. The agent registration: alone, and prepared only once the set-up had been mined.
    expect(agent!.targets).toEqual([REGISTRY]);
    expect(agent!.minedWhenPrepared).toBe(1);
  });

  for (const [name, broken] of [
    ["the registry cannot be read", { agentCount: "unreadable" }],
    ["the registry refuses the registration", { registration: "reverts" }],
    ["the relay rejects the registration", { registration: "relay-rejects" }],
  ] as const) {
    test(`still completes when ${name}`, async () => {
      const wallet = freshWallet();
      const wire = mockWire(wallet.address, broken);
      const result = await execute(wallet, createPrivateKeySigner(), [USER_CALL], { network: CELO_SEPOLIA });

      // The action is exactly what it would have been without the agent step.
      expect(result.status).toBe("CONFIRMED");
      expect(result.callsId).toBe("0x01");
      expect(result.transactionHash).toBe(`0x${"01".repeat(32)}`);
      expect(wire.bundles[0]!.targets).toEqual([CONTROLLER, USER_CALL.to]);
      // And the failure is reported, not thrown.
      expect(result.agentIdentity?.status).toBe("failed");
      expect(result.agentIdentity?.chainId).toBe(CELO_SEPOLIA.chainId);
    });
  }

  test("agentIdentity: false sends one transaction and never touches the agent registry", async () => {
    const wallet = freshWallet();
    const wire = mockWire(wallet.address);
    const result = await execute(wallet, createPrivateKeySigner(), [USER_CALL], { network: CELO_SEPOLIA, agentIdentity: false });

    expect(result.status).toBe("CONFIRMED");
    expect(result.agentIdentity).toBeUndefined();
    expect(wire.bundles).toHaveLength(1);
    expect(wire.registryReads()).toBe(0);
  });

  test("a wallet that owns an agent already is not given a second one", async () => {
    const wallet = freshWallet();
    const wire = mockWire(wallet.address, { agentCount: 1n });
    const result = await execute(wallet, createPrivateKeySigner(), [USER_CALL], { network: CELO_SEPOLIA });

    expect(result.status).toBe("CONFIRMED");
    expect(result.agentIdentity).toEqual({ status: "skipped", chainId: CELO_SEPOLIA.chainId, reason: "already-registered" });
    expect(wire.bundles).toHaveLength(1);
  });
});

describe("a wallet that is already set up", () => {
  test("is left alone: one transaction, no agent registry read, nothing on the result", async () => {
    const wallet = freshWallet();
    const wire = mockWire(wallet.address, { keysBefore: 1 });
    const result = await execute(wallet, createPrivateKeySigner(), [USER_CALL], { network: CELO_SEPOLIA });

    expect(result.status).toBe("CONFIRMED");
    expect(result.agentIdentity).toBeUndefined();
    expect(wire.bundles).toHaveLength(1);
    expect(wire.bundles[0]!.targets).toEqual([USER_CALL.to]);
    expect(wire.registryReads()).toBe(0);
  });
});
