/**
 * The agent identity a new wallet gets by itself: what the record says, when
 * the step runs, and that it can only ever report.
 *
 * The chain is faked through `AgentIdentityDeps`, so every case states exactly
 * what was read and what was sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { hexToString, type Address, type Hex } from "viem";
import { BNB, BNB_TESTNET, CELO, CELO_SEPOLIA, ETHEREUM } from "./config.js";
import {
  ALTANA_AGENT_TAG,
  DEFAULT_AGENT_DESCRIPTION,
  DEFAULT_AGENT_IMAGE,
  DEFAULT_AGENT_NAME,
  afterFirstAction,
  agentIdentityFile,
  agentPageUrl,
  altanaExplorerWalletUrl,
  registerAgentIdentity,
  type AgentIdentityDeps,
} from "./agentIdentity.js";
import { ERC8004_ADDRESSES, decodeErc8004AgentUri, encodeErc8004AgentUri } from "./erc8004.js";
import { clearFirstAction, hasFirstAction, isKnownRegistered, noteFirstAction } from "./internal/firstActions.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import type { PasskeySigner } from "./internal/passkey.js";

const WALLET = { address: "0x00000000000000000000000000000000000000a1" as Address };
const KEY_SIGNER = createPrivateKeySigner();
const PASSKEY_SIGNER = {
  type: "webauthn-p256",
  publicKey: `0x${"11".repeat(64)}`,
  credentialId: "credential",
  rpId: "localhost",
} as unknown as PasskeySigner;

/** Fake chain: a count to answer with, and what happens when the registration is sent. */
function fakeDeps(o: { count?: bigint | Error; register?: "confirm" | Error } = {}) {
  const calls = { counts: 0, registers: [] as { agentUri: string; metadata: readonly { metadataKey: string; metadataValue: Hex }[]; feeToken: unknown }[] };
  const deps: AgentIdentityDeps = {
    async agentCount() {
      calls.counts += 1;
      if (o.count instanceof Error) throw o.count;
      return o.count ?? 0n;
    },
    async register(_wallet, _signer, params, opts) {
      calls.registers.push({ agentUri: params.agentUri, metadata: params.metadata, feeToken: opts.feeToken });
      if (o.register instanceof Error) throw o.register;
      return { agentId: 4242n, callsId: "0xca11" as Hex, transactionHash: `0x${"ab".repeat(32)}` as Hex };
    },
  };
  return { deps, calls };
}

afterEach(() => {
  for (const network of [BNB, BNB_TESTNET, CELO, CELO_SEPOLIA, ETHEREUM]) clearFirstAction(network.chainId, WALLET.address);
});

describe("the record a wallet is registered with", () => {
  test("defaults: Altana Agent, the Altana icon, one line, and the wallet's page on the explorer", () => {
    const file = agentIdentityFile(CELO, WALLET.address);
    expect(file).toEqual({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "Altana Agent",
      description: DEFAULT_AGENT_DESCRIPTION,
      image: "https://docs.altana.network/altana-icon.png",
      services: [{ name: "web", endpoint: `https://explorer.altana.network/account/${WALLET.address}` }],
      registrations: [],
    });
    expect(DEFAULT_AGENT_NAME).toBe("Altana Agent");
    expect(DEFAULT_AGENT_IMAGE).toBe("https://docs.altana.network/altana-icon.png");
    expect(DEFAULT_AGENT_DESCRIPTION).not.toContain("\n");
  });

  test("a testnet wallet links to the testnet explorer", () => {
    for (const network of [BNB, CELO]) {
      expect(altanaExplorerWalletUrl(network, WALLET.address)).toBe(`https://explorer.altana.network/account/${WALLET.address}`);
    }
    for (const network of [BNB_TESTNET, CELO_SEPOLIA]) {
      expect(altanaExplorerWalletUrl(network, WALLET.address)).toBe(`https://testnet.altana.network/account/${WALLET.address}`);
    }
  });

  test("a builder's name, description, image and link replace the defaults, each on its own", () => {
    const file = agentIdentityFile(BNB, WALLET.address, {
      name: "Sentinel",
      description: "Watches a treasury.",
      image: "https://sentinel.example/logo.png",
      endpoint: "https://sentinel.example",
    });
    expect(file.name).toBe("Sentinel");
    expect(file.description).toBe("Watches a treasury.");
    expect(file.image).toBe("https://sentinel.example/logo.png");
    expect(file.services).toEqual([{ name: "web", endpoint: "https://sentinel.example" }]);

    const partial = agentIdentityFile(BNB, WALLET.address, { name: "Sentinel", description: "   " });
    expect(partial.name).toBe("Sentinel");
    expect(partial.description).toBe(DEFAULT_AGENT_DESCRIPTION);
    expect(partial.image).toBe(DEFAULT_AGENT_IMAGE);
  });

  test("it survives the onchain encoding", () => {
    const file = agentIdentityFile(CELO_SEPOLIA, WALLET.address);
    expect(decodeErc8004AgentUri(encodeErc8004AgentUri(file))).toEqual(file);
  });

  test("the tag says createdWith = altana", () => {
    expect(ALTANA_AGENT_TAG.metadataKey).toBe("createdWith");
    expect(hexToString(ALTANA_AGENT_TAG.metadataValue)).toBe("altana");
  });

  test("the agent's public page, per chain", () => {
    expect(agentPageUrl(CELO.chainId, 10072n)).toBe("https://8004scan.io/agents/celo/10072");
    expect(agentPageUrl(BNB.chainId, "334195")).toBe("https://8004scan.io/agents/bsc/334195");
    expect(agentPageUrl(CELO_SEPOLIA.chainId, 449n)).toBe("https://8004scan.io/agents/celo-sepolia/449");
    expect(agentPageUrl(BNB_TESTNET.chainId, 1n)).toBe("https://8004scan.io/agents/bsc-testnet/1");
    expect(agentPageUrl(ETHEREUM.chainId, 1n)).toBeUndefined();
  });

  test("the registry is known on BNB, Celo and their testnets, and not on Ethereum", () => {
    for (const network of [BNB, BNB_TESTNET, CELO, CELO_SEPOLIA]) expect(ERC8004_ADDRESSES[network.chainId]).toBeDefined();
    expect(ERC8004_ADDRESSES[ETHEREUM.chainId]).toBeUndefined();
  });
});

describe("registerAgentIdentity", () => {
  test("sends the default record with the Altana tag, and reports the agent's number as a string", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await registerAgentIdentity({ wallet: WALLET, signer: KEY_SIGNER, network: CELO }, deps);

    expect(outcome).toEqual({
      status: "registered",
      chainId: CELO.chainId,
      registry: ERC8004_ADDRESSES[CELO.chainId]!,
      agentId: "4242",
      callsId: "0xca11",
      transactionHash: `0x${"ab".repeat(32)}`,
    });
    expect(calls.registers).toHaveLength(1);
    expect(decodeErc8004AgentUri(calls.registers[0]!.agentUri)).toEqual(agentIdentityFile(CELO, WALLET.address));
    expect(calls.registers[0]!.metadata).toEqual([ALTANA_AGENT_TAG]);
    // A result carrying this outcome must still serialize.
    expect(() => JSON.stringify({ status: "CONFIRMED", agentIdentity: outcome })).not.toThrow();
  });

  test("pays in the fee token it was given", async () => {
    const { deps, calls } = fakeDeps();
    const usdc = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as Address;
    await registerAgentIdentity({ wallet: WALLET, signer: KEY_SIGNER, network: CELO, feeToken: usdc }, deps);
    expect(calls.registers[0]!.feeToken).toBe(usdc);
  });

  test("a wallet that owns an agent already is left as it is", async () => {
    const { deps, calls } = fakeDeps({ count: 1n });
    const outcome = await registerAgentIdentity({ wallet: WALLET, signer: KEY_SIGNER, network: BNB }, deps);
    expect(outcome).toEqual({ status: "skipped", chainId: BNB.chainId, reason: "already-registered" });
    expect(calls.registers).toHaveLength(0);
  });

  test("a chain with no registry is skipped without reading anything", async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await registerAgentIdentity({ wallet: WALLET, signer: KEY_SIGNER, network: ETHEREUM }, deps);
    expect(outcome).toEqual({ status: "skipped", chainId: ETHEREUM.chainId, reason: "no-registry" });
    expect(calls.counts).toBe(0);
    expect(calls.registers).toHaveLength(0);
  });

  test("an unreadable registry is reported, never thrown, and nothing is sent", async () => {
    const { deps, calls } = fakeDeps({ count: new Error("execution reverted\nlong detail") });
    const outcome = await registerAgentIdentity({ wallet: WALLET, signer: KEY_SIGNER, network: CELO }, deps);
    expect(outcome).toEqual({ status: "failed", chainId: CELO.chainId, reason: "execution reverted" });
    expect(calls.registers).toHaveLength(0);
  });

  test("a registration the registry refuses is reported, never thrown", async () => {
    const { deps } = fakeDeps({ register: new Error("erc8004: register reverted (callsId 0x01)") });
    const outcome = await registerAgentIdentity({ wallet: WALLET, signer: KEY_SIGNER, network: BNB }, deps);
    expect(outcome).toEqual({ status: "failed", chainId: BNB.chainId, reason: "erc8004: register reverted (callsId 0x01)" });
  });
});

describe("after an admin action", () => {
  const run = (o: Partial<Parameters<typeof afterFirstAction>[0]>, deps: AgentIdentityDeps) =>
    afterFirstAction({ wallet: WALLET, signer: KEY_SIGNER, network: CELO, option: undefined, action: "confirmed", ...o }, deps);

  test("an action that was not the wallet's first does nothing and reads nothing", async () => {
    const { deps, calls } = fakeDeps();
    expect(await run({}, deps)).toBeUndefined();
    expect(calls.counts).toBe(0);
    expect(calls.registers).toHaveLength(0);
  });

  test("a confirmed first action registers the agent, once", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(CELO.chainId, WALLET.address);

    const outcome = await run({}, deps);
    expect(outcome?.status).toBe("registered");
    expect(calls.registers).toHaveLength(1);

    // The note is spent: the wallet's next action is an ordinary one.
    expect(hasFirstAction(CELO.chainId, WALLET.address)).toBe(false);
    expect(await run({}, deps)).toBeUndefined();
    expect(calls.registers).toHaveLength(1);
  });

  test("the note is per chain and per wallet", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(BNB.chainId, WALLET.address);
    expect(await run({ network: CELO }, deps)).toBeUndefined();
    expect(await run({ network: BNB, wallet: { address: "0x00000000000000000000000000000000000000b2" } }, deps)).toBeUndefined();
    expect(calls.registers).toHaveLength(0);
    expect((await run({ network: BNB }, deps))?.status).toBe("registered");
  });

  test("agentIdentity: false sends nothing and reads nothing", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(CELO.chainId, WALLET.address);
    expect(await run({ option: false }, deps)).toBeUndefined();
    expect(calls.counts).toBe(0);
    expect(calls.registers).toHaveLength(0);
  });

  test("a builder's record is what gets registered", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(CELO.chainId, WALLET.address);
    await run({ option: { name: "Sentinel", image: "https://sentinel.example/logo.png" } }, deps);
    const sent = decodeErc8004AgentUri(calls.registers[0]!.agentUri);
    expect(sent.name).toBe("Sentinel");
    expect(sent.image).toBe("https://sentinel.example/logo.png");
    expect(sent.description).toBe(DEFAULT_AGENT_DESCRIPTION);
  });

  test("a first action that failed registers nothing; the next attempt starts over", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(CELO.chainId, WALLET.address);
    expect(await run({ action: "failed" }, deps)).toBeUndefined();
    expect(calls.registers).toHaveLength(0);
    expect(hasFirstAction(CELO.chainId, WALLET.address)).toBe(false);
  });

  test("a confirmed first action is remembered as registered, so the next action does not carry the registration again", async () => {
    // Each case has a wallet of its own: what was seen to confirm is never forgotten.
    const seen = { address: "0x00000000000000000000000000000000000000c1" as Address };
    const { deps } = fakeDeps();
    expect(isKnownRegistered(CELO.chainId, seen.address)).toBe(false);
    noteFirstAction(CELO.chainId, seen.address);
    await run({ wallet: seen }, deps);
    expect(isKnownRegistered(CELO.chainId, seen.address)).toBe(true);
    // Per chain: the same wallet's first action elsewhere still registers there.
    expect(isKnownRegistered(BNB.chainId, seen.address)).toBe(false);
  });

  test("it is remembered with agentIdentity: false too, and for a passkey wallet", async () => {
    const off = { address: "0x00000000000000000000000000000000000000c2" as Address };
    const passkey = { address: "0x00000000000000000000000000000000000000c3" as Address };
    const { deps } = fakeDeps();
    noteFirstAction(CELO.chainId, off.address);
    await run({ wallet: off, option: false }, deps);
    expect(isKnownRegistered(CELO.chainId, off.address)).toBe(true);
    noteFirstAction(CELO.chainId, passkey.address);
    await run({ wallet: passkey, signer: PASSKEY_SIGNER }, deps);
    expect(isKnownRegistered(CELO.chainId, passkey.address)).toBe(true);
  });

  test("a first action that failed or is still pending is not remembered as registered", async () => {
    const failed = { address: "0x00000000000000000000000000000000000000c4" as Address };
    const pending = { address: "0x00000000000000000000000000000000000000c5" as Address };
    const { deps } = fakeDeps();
    noteFirstAction(CELO.chainId, failed.address);
    await run({ wallet: failed, action: "failed" }, deps);
    expect(isKnownRegistered(CELO.chainId, failed.address)).toBe(false);
    noteFirstAction(CELO.chainId, pending.address);
    await run({ wallet: pending, action: "pending" }, deps);
    expect(isKnownRegistered(CELO.chainId, pending.address)).toBe(false);
    clearFirstAction(CELO.chainId, pending.address);
  });

  test("a first action still pending keeps its note for the next confirmed action", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(CELO.chainId, WALLET.address);
    expect(await run({ action: "pending" }, deps)).toBeUndefined();
    expect(calls.registers).toHaveLength(0);
    expect(hasFirstAction(CELO.chainId, WALLET.address)).toBe(true);
    expect((await run({ action: "confirmed" }, deps))?.status).toBe("registered");
  });

  test("a passkey wallet is not sent a second transaction: skipped, with the reason", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(CELO.chainId, WALLET.address);
    expect(await run({ signer: PASSKEY_SIGNER }, deps)).toEqual({ status: "skipped", chainId: CELO.chainId, reason: "passkey" });
    expect(calls.counts).toBe(0);
    expect(calls.registers).toHaveLength(0);
  });

  test("a chain with no registry reports nothing", async () => {
    const { deps, calls } = fakeDeps();
    noteFirstAction(ETHEREUM.chainId, WALLET.address);
    expect(await run({ network: ETHEREUM }, deps)).toBeUndefined();
    expect(calls.counts).toBe(0);
  });

  test("whatever the registry does, this returns an outcome and never throws", async () => {
    for (const broken of [{ count: new Error("registry unreachable") }, { register: new Error("register reverted") }] as const) {
      const { deps } = fakeDeps(broken);
      noteFirstAction(CELO.chainId, WALLET.address);
      const outcome = await run({}, deps);
      expect(outcome?.status).toBe("failed");
    }
  });
});
