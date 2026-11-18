/**
 * The agent identity a new wallet gets by itself, as this server handles it.
 *
 * The SDK does the work: after a wallet's first admin action has confirmed it
 * registers the wallet in the chain's ERC-8004 registry, in a transaction of
 * its own. This module is the three things the server adds around that:
 *
 *   - the switch (`ALTANA_AGENT_IDENTITY=off`),
 *   - what a tool answer says about the registration,
 *   - remembering the agent's number. The registry has no lookup from a wallet
 *     to its agent, so the number is written down when it is issued; that is
 *     what lets `erc8004_register` update the wallet's agent later instead of
 *     creating a second one.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { agentPageUrl, type AgentIdentityOutcome } from "@altananetwork/sdk";
import type { Address } from "viem";

/**
 * `ALTANA_AGENT_IDENTITY=off` (or `false`, `0`, `no`) turns the automatic
 * registration off. Anything else, and unset, leaves the SDK's default: on.
 */
export function agentIdentityOption(value: string | undefined): false | undefined {
  return /^(off|false|0|no)$/i.test((value ?? "").trim()) ? false : undefined;
}

export const AGENTS_FILE = join(homedir(), ".altana", "agents.json");

type AgentsFile = { v: 1; agents: Record<string, string> };

const keyOf = (chainId: number, wallet: Address): string => `${chainId}:${wallet.toLowerCase()}`;

async function readAgents(file: string): Promise<AgentsFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<AgentsFile>;
    return { v: 1, agents: parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {} };
  } catch {
    return { v: 1, agents: {} };
  }
}

/** Write down the agent number a wallet was given on a chain. */
export async function rememberAgent(chainId: number, wallet: Address, agentId: string, file = AGENTS_FILE): Promise<void> {
  const data = await readAgents(file);
  data.agents[keyOf(chainId, wallet)] = agentId;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

/** The agent number written down for a wallet on a chain, if any. */
export async function knownAgent(chainId: number, wallet: Address, file = AGENTS_FILE): Promise<string | undefined> {
  return (await readAgents(file)).agents[keyOf(chainId, wallet)];
}

/**
 * What a tool answer says about the registration. The action the tool ran is
 * complete whatever this says, and the text says so when it did not register.
 */
export function agentIdentityReport(outcome: AgentIdentityOutcome): Record<string, unknown> {
  if (outcome.status === "registered") {
    const page = agentPageUrl(outcome.chainId, outcome.agentId);
    return {
      status: "registered",
      agentId: outcome.agentId,
      registry: outcome.registry,
      ...(outcome.transactionHash ? { transactionHash: outcome.transactionHash } : {}),
      ...(page ? { page } : {}),
      note:
        "This wallet's agent identity (ERC-8004) was registered in a transaction of its own. " +
        "Change its name, description or image with erc8004_register or erc8004_set_agent_uri.",
    };
  }
  if (outcome.status === "skipped") {
    return {
      status: "skipped",
      reason: outcome.reason,
      note:
        outcome.reason === "already-registered"
          ? "This wallet owns an agent identity already; nothing was registered."
          : "No agent identity was registered. The action above is complete.",
    };
  }
  return {
    status: "failed",
    reason: outcome.reason,
    note:
      "The action above is complete. Only the agent identity registration did not go through; " +
      "erc8004_register can do it later.",
  };
}
