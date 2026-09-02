/**
 * ERC-8004 agent identity:
 *  - the pure call builders and the selector-scoped session permissions
 *  - agentId recovery from a relay receipt's Registered log
 *  - the registration-file codec (canonical JSON, byte-compatible with
 *    @bnbagent's TS/Python SDKs)
 *  - registerErc8004Agent's submission path, against a stubbed relay
 *
 * Two boundaries are stubbed, both without touching `./internal/relay.js`:
 *
 *  - `./execute.js`, via the delegating-holder pattern from
 *    sessionKeyRegistration.test.ts (holders DEFAULT to the real
 *    implementations; swapped in this file's beforeEach, handed back in
 *    afterAll). A mocked module specifier needs exactly one owning test file —
 *    `./internal/relay.js` belongs to sessionKeyRegistration.test.ts, and
 *    registering it a second time here deadlocks the run against
 *    client.balances.test.ts, the same pairing that file's header warns about.
 *  - `waitForCalls`'s relay client, which is a plain `{ request }` stub — no
 *    module mock needed at all to prove receipts survive the status decode.
 */
import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import {
  decodeFunctionData,
  pad,
  toEventSelector,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { BNB_TESTNET } from "./config.js";
import { erc8183Addresses } from "./erc8183.js";
import { waitForCalls } from "./internal/relay.js";
import type { Session } from "./internal/sessions.js";
import type { ExecuteOptions } from "./execute.js";
import type { Call } from "./internal/relay.js";

const realExecute = await import("./execute.js");

// ---- delegating holder (default: real) ------------------------------------
let executeWithReceiptsImpl: any = realExecute.executeWithReceipts;

mock.module("./execute.js", () => ({
  ...realExecute,
  executeWithReceipts: (...a: any[]) => executeWithReceiptsImpl(...a),
}));

const {
  buildErc8004RegisterCall,
  buildErc8004SetAgentUriCall,
  erc8004RegisterPermissions,
  findRegisteredAgentId,
  registerErc8004Agent,
  setErc8004AgentUri,
  encodeErc8004AgentUri,
  decodeErc8004AgentUri,
  withErc8004Registration,
} = await import("./erc8004.js");
const { createPrivateKeySigner } = await import("./internal/signer.js");

const REGISTRY = erc8183Addresses(97).registry;
const WALLET = "0x1111111111111111111111111111111111111111" as Address;

// An independent restatement of the deployed ABI (verified against
// @bnbagent/sdk@0.5.0's identityRegistryAbi and the live BSC contracts) — the
// point is to decode what the module encoded, not to reuse its own constant.
const REGISTRY_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentURI", type: "string" },
      {
        name: "metadata",
        type: "tuple[]",
        components: [
          { name: "metadataKey", type: "string" },
          { name: "metadataValue", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "setAgentURI",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
] as const;

const TX = "0xfeed0000000000000000000000000000000000000000000000000000000000ff" as Hex;

const REGISTERED_TOPIC = toEventSelector("Registered(uint256,string,address)");
const registeredLog = (registry: Address, owner: Address, agentId: bigint) => ({
  address: registry,
  topics: [REGISTERED_TOPIC, pad(toHex(agentId), { size: 32 }), pad(owner.toLowerCase() as Hex, { size: 32 })],
  data: "0x" as Hex,
});

const FILE = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Vault Sentinel",
  description: "Watches Venus positions",
  image: "",
  services: [{ name: "A2A", endpoint: "https://sentinel.example/.well-known/agent-card.json" }],
  registrations: [{ agentId: 42, agentRegistry: `eip155:97:${REGISTRY}` }],
} as const;

// ============================== builders =====================================

describe("call builders", () => {
  test("register targets the registry and round-trips its args", () => {
    const call = buildErc8004RegisterCall(97, "data:application/json;base64,e30=", [
      { metadataKey: "built_with", metadataValue: toHex("altana-sdk") },
    ]);
    expect(call.to).toBe(REGISTRY);
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data: call.data! });
    expect(functionName).toBe("register");
    expect(args[0]).toBe("data:application/json;base64,e30=");
    expect(args[1]).toEqual([{ metadataKey: "built_with", metadataValue: toHex("altana-sdk") }]);
  });

  test("register defaults metadata to an empty array", () => {
    const { args } = decodeFunctionData({
      abi: REGISTRY_ABI,
      data: buildErc8004RegisterCall(97, "data:application/json;base64,e30=").data!,
    });
    expect(args[1]).toEqual([]);
  });

  test("setAgentURI targets the registry and round-trips its args", () => {
    const call = buildErc8004SetAgentUriCall(97, 7n, "data:application/json;base64,e30=");
    expect(call.to).toBe(REGISTRY);
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data: call.data! });
    expect(functionName).toBe("setAgentURI");
    expect(args).toEqual([7n, "data:application/json;base64,e30="]);
  });

  test("both builders reuse the ERC-8183 registry address, and reject unknown chains", () => {
    expect(buildErc8004RegisterCall(56, "x").to).toBe(erc8183Addresses(56).registry);
    expect(() => buildErc8004RegisterCall(1, "x")).toThrow(/chainId 1/);
    expect(() => buildErc8004SetAgentUriCall(1, 1n, "x")).toThrow(/chainId 1/);
    expect(() => erc8004RegisterPermissions(1)).toThrow(/chainId 1/);
  });
});

// ============================== permissions ==================================

describe("erc8004RegisterPermissions", () => {
  // `register` is overloaded three ways on the registry — (), (string), and
  // (string,(string,bytes)[]) — so the permission's signature string has to
  // name the SAME overload the builder encodes, or the on-chain selector match
  // silently fails. This pins the two together.
  test("each permission's selector is the one its builder actually encodes", () => {
    const [registerPerm, setUriPerm] = erc8004RegisterPermissions(97) as [
      { to: Address; signature: string },
      { to: Address; signature: string },
    ];
    expect(toFunctionSelector(registerPerm.signature)).toBe(
      buildErc8004RegisterCall(97, "x").data!.slice(0, 10),
    );
    expect(toFunctionSelector(setUriPerm.signature)).toBe(
      buildErc8004SetAgentUriCall(97, 1n, "x").data!.slice(0, 10),
    );
  });

  test("grants exactly two calls, both scoped to the registry by selector", () => {
    const perms = erc8004RegisterPermissions(97);
    expect(perms).toHaveLength(2);
    for (const p of perms) {
      expect((p as { to: Address }).to).toBe(REGISTRY);
      // A to-only entry would be a registry-wide grant. Never emit one.
      expect((p as { signature?: string }).signature).toBeTruthy();
    }
  });

  // The session executes AS the wallet, which owns the identity NFT. A grant
  // that reached any of these would let a compromised session steal or poison
  // the identity — setApprovalForAll even outliving the session's revocation.
  test("grants none of the transfer, approval or agent-wallet selectors", () => {
    const granted = erc8004RegisterPermissions(97).map((p) =>
      toFunctionSelector((p as { signature: string }).signature),
    );
    for (const dangerous of [
      "transferFrom(address,address,uint256)",
      "safeTransferFrom(address,address,uint256)",
      "safeTransferFrom(address,address,uint256,bytes)",
      "approve(address,uint256)",
      "setApprovalForAll(address,bool)",
      "setAgentWallet(uint256,address,uint256,bytes)",
      "setMetadata(uint256,string,bytes)",
    ]) {
      expect(granted).not.toContain(toFunctionSelector(dangerous));
    }
  });
});

// ============================ Registered parsing =============================

describe("findRegisteredAgentId", () => {
  test("reads the agentId from a matching log", () => {
    expect(findRegisteredAgentId([registeredLog(REGISTRY, WALLET, 4242n)], REGISTRY, WALLET)).toBe(4242n);
  });

  test("ignores a same-topic log emitted by a different contract", () => {
    const impostor = "0x00000000000000000000000000000000000000ff" as Address;
    expect(findRegisteredAgentId([registeredLog(impostor, WALLET, 9n)], REGISTRY, WALLET)).toBeUndefined();
  });

  // The relay bundles intents: one receipt can carry another wallet's
  // Registered from the very same registry.
  test("ignores a log from the right registry with a different owner", () => {
    const other = "0x00000000000000000000000000000000000000a1" as Address;
    expect(findRegisteredAgentId([registeredLog(REGISTRY, other, 9n)], REGISTRY, WALLET)).toBeUndefined();
  });

  test("picks ours out of a bundle that also carries someone else's", () => {
    const other = "0x00000000000000000000000000000000000000a1" as Address;
    const logs = [registeredLog(REGISTRY, other, 9n), registeredLog(REGISTRY, WALLET, 10n)];
    expect(findRegisteredAgentId(logs, REGISTRY, WALLET)).toBe(10n);
  });

  test("matches regardless of address casing on either side", () => {
    const log = registeredLog(REGISTRY.toUpperCase() as Address, WALLET, 5n);
    expect(findRegisteredAgentId([log], REGISTRY.toLowerCase() as Address, WALLET)).toBe(5n);
  });

  test("no logs at all → undefined", () => {
    expect(findRegisteredAgentId([], REGISTRY, WALLET)).toBeUndefined();
  });
});

// ========================== registration file codec ==========================

describe("registration file", () => {
  test("encode/decode round-trips", () => {
    expect(decodeErc8004AgentUri(encodeErc8004AgentUri(FILE))).toEqual(FILE);
  });

  // The byte-compat guarantee: canonical JSON sorts keys at every depth, so
  // two records differing only in key order produce the identical URI — and
  // therefore hash identically across @bnbagent's TS and Python SDKs.
  test("canonical ordering is stable across input key order", () => {
    const reordered = {
      registrations: FILE.registrations,
      services: FILE.services,
      image: FILE.image,
      description: FILE.description,
      name: FILE.name,
      type: FILE.type,
    } as typeof FILE;
    expect(encodeErc8004AgentUri(reordered)).toBe(encodeErc8004AgentUri(FILE));
  });

  // Pinned against @bnbagent/sdk@0.5.0's own canonicalJson +
  // encodeRegistrationFileToBase64 for this exact record. If this fails, our
  // records no longer hash the same as theirs.
  test("matches @bnbagent's encoding byte for byte", () => {
    expect(encodeErc8004AgentUri(FILE)).toBe(
      "data:application/json;base64,eyJkZXNjcmlwdGlvbiI6IldhdGNoZXMgVmVudXMgcG9zaXRpb25zIiwiaW1hZ2UiOiIiLCJuYW1lIjoiVmF1bHQgU2VudGluZWwiLCJyZWdpc3RyYXRpb25zIjpbeyJhZ2VudElkIjo0MiwiYWdlbnRSZWdpc3RyeSI6ImVpcDE1NTo5NzoweDgwMDRBODE4QkZCOTEyMjMzYzQ5MTg3MWIzZDg0Yzg5QTQ5NEJEOWUifV0sInNlcnZpY2VzIjpbeyJlbmRwb2ludCI6Imh0dHBzOi8vc2VudGluZWwuZXhhbXBsZS8ud2VsbC1rbm93bi9hZ2VudC1jYXJkLmpzb24iLCJuYW1lIjoiQTJBIn1dLCJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSJ9",
    );
  });

  test("escapes non-ASCII as \\uXXXX, like the Python SDK's json.dumps", () => {
    const uri = encodeErc8004AgentUri({ ...FILE, name: "Café ☕" });
    const json = Buffer.from(uri.split(",")[1]!, "base64").toString("utf8");
    expect(json).toContain('"name":"Caf\\u00e9 \\u2615"');
    expect(decodeErc8004AgentUri(uri).name).toBe("Café ☕");
  });

  test("decode rejects a URI that is not a base64 JSON data URI", () => {
    expect(() => decodeErc8004AgentUri("https://sentinel.example/agent.json")).toThrow(/data URI/);
  });

  test("decode rejects a payload that is not JSON", () => {
    const bad = "data:application/json;base64," + Buffer.from("{nope", "utf8").toString("base64");
    expect(() => decodeErc8004AgentUri(bad)).toThrow(/not valid JSON/);
  });
});

describe("withErc8004Registration", () => {
  test("patches the id in without mutating the input", () => {
    const phase1 = { ...FILE, registrations: [] as { agentId: number; agentRegistry: string }[] };
    const patched = withErc8004Registration(phase1, 77n, 97);
    expect(patched.registrations).toEqual([{ agentId: 77, agentRegistry: `eip155:97:${REGISTRY}` }]);
    expect(phase1.registrations).toEqual([]);
  });

  test("replaces this chain's entry and keeps the others — one agent, several chains", () => {
    const mainnet = { agentId: 1, agentRegistry: `eip155:56:${erc8183Addresses(56).registry}` };
    const patched = withErc8004Registration(
      { ...FILE, registrations: [mainnet, { agentId: 5, agentRegistry: `eip155:97:${REGISTRY}` }] },
      99n,
      97,
    );
    expect(patched.registrations).toEqual([mainnet, { agentId: 99, agentRegistry: `eip155:97:${REGISTRY}` }]);
  });

  test("refuses an agentId a JSON number cannot hold", () => {
    expect(() => withErc8004Registration(FILE, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 97)).toThrow(
      /MAX_SAFE_INTEGER/,
    );
  });
});

// ========================= relay receipts round-trip =========================

// waitForCalls is where the logs enter the SDK. `getCallsStatus` decodes the
// relay's response through a zod schema before we ever see it, so this drives
// the real decode with a `{ request }` client rather than asserting on a shape
// we invented. If the relay's receipt schema ever drops `logs`, this fails
// here instead of at registration time.
describe("waitForCalls", () => {
  const statusResponse = (status: number) => ({
    id: "0xcallsid",
    status,
    receipts: [
      {
        blockHash: pad("0xab", { size: 32 }),
        blockNumber: "0x1",
        chainId: "0x61",
        gasUsed: "0x5208",
        status: "0x1",
        transactionHash: TX,
        logs: [{ address: REGISTRY.toLowerCase(), data: "0x", topics: [REGISTERED_TOPIC] }],
      },
    ],
  });
  const clientReturning = (response: unknown) => ({ request: async () => response }) as any;

  test("surfaces the receipts' logs on a confirmed bundle", async () => {
    const result = await waitForCalls(clientReturning(statusResponse(200)), "0xcallsid");

    expect(result.status).toBe("CONFIRMED");
    expect(result.transactionHash).toBe(TX);
    expect(result.receipts?.[0]?.logs?.[0]?.topics[0]).toBe(REGISTERED_TOPIC);
    expect(result.receipts?.[0]?.logs?.[0]?.address?.toLowerCase()).toBe(REGISTRY.toLowerCase());
  });

  test("surfaces them on a failed bundle too — a revert still has logs to read", async () => {
    const result = await waitForCalls(clientReturning(statusResponse(500)), "0xcallsid");
    expect(result.status).toBe("FAILED");
    expect(result.statusCode).toBe(500);
    expect(result.receipts).toHaveLength(1);
  });

  // The relay's codes follow the EIP-5792 bands: 1xx in flight, 2xx success,
  // 300-699 terminal failure. Issue #57: 300 (rejected before inclusion —
  // e.g. a spend cap that cannot cover the relay fee) used to fall through
  // the loop and poll for the whole 240s deadline before answering PENDING.

  test("a 300 pre-inclusion rejection is terminal on the first poll (#57)", async () => {
    // No receipts on a rejected bundle — mirror the live relay's response.
    const result = await waitForCalls(
      clientReturning({ id: "0xcallsid", status: 300, receipts: [] }),
      "0xcallsid",
    );
    expect(result.status).toBe("FAILED");
    expect(result.statusCode).toBe(300);
  });

  test("confirmed bundles report their code too", async () => {
    const result = await waitForCalls(clientReturning(statusResponse(200)), "0xcallsid");
    expect(result.statusCode).toBe(200);
  });

  test("1xx keeps polling; the timeout PENDING carries the last observed code", async () => {
    const result = await waitForCalls(
      clientReturning({ id: "0xcallsid", status: 100, receipts: [] }),
      "0xcallsid",
      50,
      5,
    );
    expect(result.status).toBe("PENDING");
    expect(result.statusCode).toBe(100);
  });

  test("an out-of-band code polls rather than guessing terminal — FAILED must stay safe to resubmit", async () => {
    const result = await waitForCalls(
      clientReturning({ id: "0xcallsid", status: 999, receipts: [] }),
      "0xcallsid",
      50,
      5,
    );
    expect(result.status).toBe("PENDING");
    expect(result.statusCode).toBe(999);
  });

  test("a relay that never answers times out to PENDING with no statusCode", async () => {
    const failing = { request: async () => { throw new Error("relay down"); } } as any;
    const result = await waitForCalls(failing, "0xcallsid", 50, 5);
    expect(result.status).toBe("PENDING");
    expect(result.statusCode).toBeUndefined();
  });
});

// ====================== submission against a stubbed execute =================

const AGENT_URI = "data:application/json;base64,e30=";

/** What erc8004 handed the execute seam on the last call. */
type Seam = { target: any; signer: any; calls: Call[]; opts: ExecuteOptions };
let seam: Seam | null = null;
let seamResult: any;

function makeSession(): Session {
  const signer = createPrivateKeySigner();
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {
      calls: erc8004RegisterPermissions(97),
      spend: [{ limit: 10n ** 16n, period: "day" as const }],
    },
    expiry: 1_800_000_000,
  };
}

const confirmedWith = (...logs: ReturnType<typeof registeredLog>[]) => ({
  callsId: "0xcallsid" as Hex,
  status: "CONFIRMED" as const,
  transactionHash: TX,
  receipts: [{ transactionHash: TX, logs }],
});

beforeEach(() => {
  seam = null;
  seamResult = confirmedWith(registeredLog(REGISTRY, WALLET, 4242n));
  executeWithReceiptsImpl = async (...args: any[]) => {
    const isSessionCall = "walletAddress" in args[0];
    const callsArg = isSessionCall ? args[1] : args[2];
    seam = {
      target: args[0],
      signer: isSessionCall ? undefined : args[1],
      calls: Array.isArray(callsArg) ? callsArg : [callsArg],
      opts: isSessionCall ? args[2] : args[3],
    };
    return seamResult;
  };
});

// Hand the real implementation back to every suite that runs after this file.
afterAll(() => {
  executeWithReceiptsImpl = realExecute.executeWithReceipts;
});

describe("registerErc8004Agent", () => {
  test("submits the register call and recovers the agentId from the relay's receipt", async () => {
    const result = await registerErc8004Agent(makeSession(), { agentUri: AGENT_URI }, { network: BNB_TESTNET });

    expect(result.agentId).toBe(4242n);
    expect(result.status).toBe("CONFIRMED");
    expect(result.transactionHash).toBe(TX);
    // The raw relay receipts stay internal — the result is an ExecuteResult.
    expect("receipts" in result).toBe(false);

    expect(seam!.calls).toHaveLength(1);
    expect(seam!.calls[0]!.to).toBe(REGISTRY);
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data: seam!.calls[0]!.data! });
    expect(functionName).toBe("register");
    expect(args[0]).toBe(AGENT_URI);
  });

  // The relay recomputes the session key's hash from the descriptor built out
  // of these permissions. Any drift — a re-cased address, a reordered entry —
  // makes the key hash unknown at execute time, so this module must forward
  // the granted Session untouched rather than rebuild anything from it.
  test("forwards the granted session untouched, permissions byte-exact", async () => {
    const session = makeSession();

    await registerErc8004Agent(session, { agentUri: AGENT_URI }, { network: BNB_TESTNET });

    expect(seam!.target).toBe(session);
    expect(seam!.target.permissions).toBe(session.permissions);
    expect(seam!.target.permissions.calls).toEqual([
      { to: REGISTRY, signature: "register(string,(string,bytes)[])" },
      { to: REGISTRY, signature: "setAgentURI(uint256,string)" },
    ]);
  });

  test("admin path forwards the wallet and its signer", async () => {
    const signer = createPrivateKeySigner();
    await registerErc8004Agent({ address: WALLET }, signer, { agentUri: AGENT_URI }, { network: BNB_TESTNET });

    expect(seam!.target).toEqual({ address: WALLET });
    expect(seam!.signer).toBe(signer);
    expect(seam!.calls[0]!.to).toBe(REGISTRY);
  });

  test("forwards metadata entries to the call", async () => {
    await registerErc8004Agent(
      makeSession(),
      { agentUri: AGENT_URI, metadata: [{ metadataKey: "built_with", metadataValue: toHex("altana") }] },
      { network: BNB_TESTNET },
    );
    const { args } = decodeFunctionData({ abi: REGISTRY_ABI, data: seam!.calls[0]!.data! });
    expect(args[1]).toEqual([{ metadataKey: "built_with", metadataValue: toHex("altana") }]);
  });

  test("picks our agentId out of a bundle carrying another wallet's Registered", async () => {
    const other = "0x00000000000000000000000000000000000000a1" as Address;
    seamResult = confirmedWith(registeredLog(REGISTRY, other, 9n), registeredLog(REGISTRY, WALLET, 10n));

    const result = await registerErc8004Agent(makeSession(), { agentUri: AGENT_URI }, { network: BNB_TESTNET });
    expect(result.agentId).toBe(10n);
  });

  test("FAILED throws, and points at the missing permission", async () => {
    seamResult = { callsId: "0xcallsid", status: "FAILED" };
    await expect(
      registerErc8004Agent(makeSession(), { agentUri: AGENT_URI }, { network: BNB_TESTNET }),
    ).rejects.toThrow(/erc8004: register reverted.*erc8004RegisterPermissions\(97\)/s);
  });

  // The mint may still land after the wait gives up, so the message has to
  // carry the callsId — registering again would mint a second identity.
  test("PENDING after the relay wait throws with the callsId", async () => {
    seamResult = { callsId: "0xcallsid", status: "PENDING" };
    await expect(
      registerErc8004Agent(makeSession(), { agentUri: AGENT_URI }, { network: BNB_TESTNET }),
    ).rejects.toThrow(/did not confirm.*callsId 0xcallsid/s);
  });

  test("confirmed but no Registered log for us throws with the tx hash", async () => {
    const other = "0x00000000000000000000000000000000000000a1" as Address;
    seamResult = confirmedWith(registeredLog(REGISTRY, other, 9n));
    await expect(
      registerErc8004Agent(makeSession(), { agentUri: AGENT_URI }, { network: BNB_TESTNET }),
    ).rejects.toThrow(new RegExp(`no Registered event.*${TX}`, "s"));
  });

  test("noWait is rejected before anything is submitted", async () => {
    await expect(
      registerErc8004Agent(makeSession(), { agentUri: AGENT_URI }, { network: BNB_TESTNET, noWait: true }),
    ).rejects.toThrow(/do not pass noWait/);
    expect(seam).toBeNull();
  });
});

describe("setErc8004AgentUri", () => {
  test("submits setAgentURI and returns a plain ExecuteResult", async () => {
    seamResult = { callsId: "0xcallsid", status: "CONFIRMED", transactionHash: TX, receipts: [{ logs: [] }] };

    const result = await setErc8004AgentUri(
      makeSession(),
      { agentId: 4242n, agentUri: AGENT_URI },
      { network: BNB_TESTNET },
    );

    expect(result).toEqual({ callsId: "0xcallsid", status: "CONFIRMED", transactionHash: TX });
    expect(seam!.calls[0]!.to).toBe(REGISTRY);
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data: seam!.calls[0]!.data! });
    expect(functionName).toBe("setAgentURI");
    expect(args).toEqual([4242n, AGENT_URI]);
  });

  // Phase 2 reads nothing back, so unlike register it can be fire-and-forget.
  test("passes noWait through", async () => {
    seamResult = { callsId: "0xcallsid", status: "PENDING" };

    const result = await setErc8004AgentUri(
      makeSession(),
      { agentId: 4242n, agentUri: AGENT_URI },
      { network: BNB_TESTNET, noWait: true },
    );

    expect(seam!.opts.noWait).toBe(true);
    expect(result).toEqual({ callsId: "0xcallsid", status: "PENDING" });
  });
});
