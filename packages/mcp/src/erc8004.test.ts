/**
 * ERC-8004 tool logic: the registration file the tools build, the
 * client-side permission pre-check, and the two-phase orchestration —
 * including the partial-registration path where the mint lands but the
 * write-back does not.
 *
 * The SDK writes are injected rather than module-mocked, so nothing here
 * touches a relay and no module mock can leak into another suite.
 */
import { test, expect, describe } from "bun:test";
import { toFunctionSelector, toHex, type Address, type Hex } from "viem";
import {
  decodeErc8004AgentUri,
  erc8004RegisterPermissions,
  erc8183Addresses,
} from "@altananetwork/sdk";
import {
  assertErc8004Permissions,
  buildRegistrationFile,
  missingErc8004Permissions,
  runErc8004Registration,
  toMetadataEntries,
  type Erc8004Writers,
} from "./erc8004.js";
import type { SessionPermissions } from "./sessions.js";

const CHAIN = 97;
const REGISTRY = erc8183Addresses(CHAIN).registry;
const TX_MINT = "0xaa00000000000000000000000000000000000000000000000000000000000001" as Hex;
const TX_PATCH = "0xbb00000000000000000000000000000000000000000000000000000000000002" as Hex;

const FIELDS = {
  name: "Vault Sentinel",
  description: "Watches Venus positions",
  endpoint: "https://sentinel.example/.well-known/agent-card.json",
};

const scoped: SessionPermissions = {
  calls: erc8004RegisterPermissions(CHAIN) as ReadonlyArray<{ to?: Address; signature?: string }>,
};

// ============================ registration file ==============================

describe("buildRegistrationFile", () => {
  test("builds a phase-1 record: no registrations, A2A by default", () => {
    const file = buildRegistrationFile(FIELDS);
    expect(file.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(file.registrations).toEqual([]);
    expect(file.services).toEqual([{ name: "A2A", endpoint: FIELDS.endpoint }]);
    expect(file.image).toBe("");
  });

  test("carries an explicit protocol, version and image through", () => {
    const file = buildRegistrationFile({
      ...FIELDS,
      serviceName: "MCP",
      version: "1.2",
      image: "https://img.example/a.png",
    });
    expect(file.services).toEqual([{ name: "MCP", endpoint: FIELDS.endpoint, version: "1.2" }]);
    expect(file.image).toBe("https://img.example/a.png");
  });
});

test("toMetadataEntries hex-encodes plain string values", () => {
  expect(toMetadataEntries([{ key: "built_with", value: "altana" }])).toEqual([
    { metadataKey: "built_with", metadataValue: toHex("altana") },
  ]);
  expect(toMetadataEntries()).toEqual([]);
});

// ============================ permission pre-check ===========================

describe("missingErc8004Permissions", () => {
  test("a session granted the ERC-8004 permissions is missing nothing", () => {
    expect(missingErc8004Permissions(scoped, CHAIN)).toEqual([]);
  });

  test("an unrestricted session (no calls rule) can call anything", () => {
    expect(missingErc8004Permissions({}, CHAIN)).toEqual([]);
    expect(missingErc8004Permissions(undefined, CHAIN)).toEqual([]);
  });

  test("a session scoped to something else is missing both", () => {
    const elsewhere: SessionPermissions = {
      calls: [{ to: erc8183Addresses(CHAIN).commerce, signature: "fund(uint256,uint256,bytes)" }],
    };
    expect(missingErc8004Permissions(elsewhere, CHAIN)).toEqual([
      "register(string,(string,bytes)[])",
      "setAgentURI(uint256,string)",
    ]);
  });

  test("names only what is actually missing", () => {
    const half: SessionPermissions = {
      calls: [{ to: REGISTRY, signature: "register(string,(string,bytes)[])" }],
    };
    expect(missingErc8004Permissions(half, CHAIN)).toEqual(["setAgentURI(uint256,string)"]);
  });

  // The registry's `register` is overloaded three ways; the no-arg one has a
  // different selector and does not authorize the call we build.
  test("the wrong register overload does not count", () => {
    const wrong: SessionPermissions = { calls: [{ to: REGISTRY, signature: "register(string)" }] };
    expect(missingErc8004Permissions(wrong, CHAIN)).toContain("register(string,(string,bytes)[])");
  });

  test("the right selector at the wrong address does not count", () => {
    const wrongTarget: SessionPermissions = {
      calls: erc8004RegisterPermissions(CHAIN).map((p) => ({
        ...(p as { signature: string }),
        to: erc8183Addresses(CHAIN).commerce,
      })),
    };
    expect(missingErc8004Permissions(wrongTarget, CHAIN)).toHaveLength(2);
  });

  // Porto passes a raw hex selector through verbatim, so a session may hold
  // the selector rather than the signature string.
  test("a raw hex selector satisfies the check", () => {
    const hexScoped: SessionPermissions = {
      calls: erc8004RegisterPermissions(CHAIN).map((p) => ({
        to: REGISTRY,
        signature: toFunctionSelector((p as { signature: string }).signature),
      })),
    };
    expect(missingErc8004Permissions(hexScoped, CHAIN)).toEqual([]);
  });

  // The SDK never emits one — it would also authorize transferFrom on the
  // identity the wallet owns — but it does work on chain, so a session granted
  // one elsewhere must not be turned away.
  test("a registry-wide to-only grant satisfies the check", () => {
    expect(missingErc8004Permissions({ calls: [{ to: REGISTRY }] }, CHAIN)).toEqual([]);
  });
});

describe("assertErc8004Permissions", () => {
  test("passes a correctly scoped session", () => {
    expect(() => assertErc8004Permissions("sentinel", scoped, CHAIN)).not.toThrow();
  });

  test("names the session, what is missing, and how to fix it", () => {
    expect(() => assertErc8004Permissions("sentinel", { calls: [{ to: REGISTRY, signature: "x()" }] }, CHAIN))
      .toThrow(/"sentinel".*missing register\(string,\(string,bytes\)\[\]\).*erc8004RegisterPermissions\(97\)/s);
  });
});

// ============================ two-phase orchestration ========================

/** Records both phases and lets each test decide how they behave. */
function stubWriters(overrides: Partial<Erc8004Writers> = {}) {
  const seen: { register?: any; setUri?: any } = {};
  const writers: Erc8004Writers = {
    registerAgent: async (_session, params) => {
      seen.register = params;
      return { callsId: "0x1" as Hex, status: "CONFIRMED", transactionHash: TX_MINT, agentId: 4242n };
    },
    setAgentUri: async (_session, params) => {
      seen.setUri = params;
      return { callsId: "0x2" as Hex, status: "CONFIRMED", transactionHash: TX_PATCH };
    },
    ...overrides,
  };
  return { writers, seen };
}

const run = (writers: Erc8004Writers, metadata?: readonly { metadataKey: string; metadataValue: Hex }[]) =>
  runErc8004Registration(
    {
      session: {},
      chainId: CHAIN,
      opts: { network: {} },
      file: buildRegistrationFile(FIELDS),
      ...(metadata ? { metadata } : {}),
    },
    writers,
  );

describe("runErc8004Registration", () => {
  test("mints with an empty registrations list, then writes the id back", async () => {
    const { writers, seen } = stubWriters();

    const outcome = await run(writers);

    // Phase 1: the record cannot yet name an id that does not exist.
    expect(decodeErc8004AgentUri(seen.register.agentUri).registrations).toEqual([]);
    // Phase 2: the same record, with the minted id bound to this registry.
    expect(seen.setUri.agentId).toBe(4242n);
    expect(decodeErc8004AgentUri(seen.setUri.agentUri).registrations).toEqual([
      { agentId: 4242, agentRegistry: `eip155:97:${REGISTRY}` },
    ]);

    expect(outcome.complete).toBe(true);
    expect(outcome.agentId).toBe("4242");
    expect(outcome.registerTransactionHash).toBe(TX_MINT);
    expect(outcome.setAgentUriTransactionHash).toBe(TX_PATCH);
    expect(outcome.agentUri).toBe(seen.setUri.agentUri);
  });

  test("forwards metadata to the mint, and omits the field when there is none", async () => {
    const withMd = stubWriters();
    await run(withMd.writers, [{ metadataKey: "built_with", metadataValue: toHex("altana") }]);
    expect(withMd.seen.register.metadata).toEqual([
      { metadataKey: "built_with", metadataValue: toHex("altana") },
    ]);

    const without = stubWriters();
    await run(without.writers, []);
    expect("metadata" in without.seen.register).toBe(false);
  });

  // The token is minted and paid for, and there is no reverse lookup to find
  // it again — so a phase-2 failure must return the id, not throw it away.
  test("a thrown phase 2 keeps the agentId and says how to repair", async () => {
    const { writers } = stubWriters({
      setAgentUri: async () => {
        throw new Error("session key expired");
      },
    });

    const outcome = await run(writers);

    expect(outcome.agentId).toBe("4242");
    expect(outcome.complete).toBe(false);
    expect(outcome.registerTransactionHash).toBe(TX_MINT);
    expect(outcome.setAgentUriTransactionHash).toBeUndefined();
    expect(outcome.message).toMatch(/session key expired/);
    expect(outcome.message).toMatch(/erc8004_set_agent_uri with agentId=4242/);
    expect(outcome.message).toMatch(/Do NOT register again/);
    // The record on chain is still phase 1's, so report that one.
    expect(decodeErc8004AgentUri(outcome.agentUri).registrations).toEqual([]);
  });

  test("a FAILED phase 2 is treated the same as a thrown one", async () => {
    const { writers } = stubWriters({
      setAgentUri: async () => ({ callsId: "0x2" as Hex, status: "FAILED" }),
    });

    const outcome = await run(writers);

    expect(outcome.complete).toBe(false);
    expect(outcome.agentId).toBe("4242");
    expect(outcome.message).toMatch(/relay reported FAILED/);
  });

  // The relay wait running out is not success: the record may never land, and
  // reporting complete would tell the caller to stop looking at it.
  test("a PENDING phase 2 is a partial registration, not a complete one", async () => {
    const { writers } = stubWriters({
      setAgentUri: async () => ({ callsId: "0x2" as Hex, status: "PENDING" }),
    });

    const outcome = await run(writers);

    expect(outcome.complete).toBe(false);
    expect(outcome.message).toMatch(/relay reported PENDING/);
    expect(outcome.message).toMatch(/erc8004_set_agent_uri with agentId=4242/);
  });

  // Phase 1 failing means no identity exists — nothing to salvage, so the
  // error belongs to the caller.
  test("a failed mint propagates", async () => {
    const { writers } = stubWriters({
      registerAgent: async () => {
        throw new Error("erc8004: register reverted");
      },
    });
    await expect(run(writers)).rejects.toThrow(/register reverted/);
  });
});
