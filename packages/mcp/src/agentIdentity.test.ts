import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { agentIdentityOption, agentIdentityReport, knownAgent, rememberAgent } from "./agentIdentity.js";

const WALLET = "0x00000000000000000000000000000000000000A1" as Address;
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;

describe("ALTANA_AGENT_IDENTITY", () => {
  test("unset or anything else leaves it on", () => {
    for (const value of [undefined, "", "on", "true", "1", "yes"]) expect(agentIdentityOption(value)).toBeUndefined();
  });
  test("off, false, 0 and no turn it off", () => {
    for (const value of ["off", "OFF", " false ", "0", "no"]) expect(agentIdentityOption(value)).toBe(false);
  });
});

describe("the agent number a wallet was given", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("is written down per chain and read back whatever the address's case", async () => {
    dir = await mkdtemp(join(tmpdir(), "altana-agents-"));
    const file = join(dir, "nested", "agents.json");
    expect(await knownAgent(42220, WALLET, file)).toBeUndefined();

    await rememberAgent(42220, WALLET, "10072", file);
    await rememberAgent(56, WALLET, "7", file);

    expect(await knownAgent(42220, WALLET.toLowerCase() as Address, file)).toBe("10072");
    expect(await knownAgent(56, WALLET, file)).toBe("7");
    expect(await knownAgent(97, WALLET, file)).toBeUndefined();
  });
});

describe("what a tool answer says", () => {
  test("registered: the number, the transaction and the public page", () => {
    const report = agentIdentityReport({
      status: "registered",
      chainId: 42220,
      registry: REGISTRY,
      agentId: "10072",
      callsId: "0x01",
      transactionHash: `0x${"ab".repeat(32)}`,
    });
    expect(report.status).toBe("registered");
    expect(report.agentId).toBe("10072");
    expect(report.transactionHash).toBe(`0x${"ab".repeat(32)}`);
    expect(report.page).toBe("https://8004scan.io/agents/celo/10072");
  });

  test("failed: says the action itself is complete", () => {
    const report = agentIdentityReport({ status: "failed", chainId: 56, reason: "register reverted" });
    expect(report.status).toBe("failed");
    expect(report.reason).toBe("register reverted");
    expect(String(report.note)).toContain("The action above is complete");
  });

  test("skipped: gives the reason", () => {
    expect(agentIdentityReport({ status: "skipped", chainId: 56, reason: "already-registered" }).reason).toBe("already-registered");
  });
});
