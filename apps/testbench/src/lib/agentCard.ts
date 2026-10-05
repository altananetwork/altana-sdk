/**
 * Reading an ERC-8004 identity record.
 *
 * The registry stores a URI, and the SDK writes it as a
 * `data:application/json;base64,…` so the record travels with the token and
 * needs no host. It can also be an ordinary URL, which is what the Altana
 * agent's record points at, so both are handled: the data URI is decoded in
 * the browser, and an http one is fetched.
 */

/**
 * What the registry actually stores, read off Altana's own agent 449 on Celo
 * Sepolia: an **ERC-8004 registration-v1** record, not an A2A agent card.
 *
 * ```json
 * { "name": "...", "description": "...", "image": "...",
 *   "registrations": [{ "agentId": 449, "agentRegistry": "eip155:11142220:0x8004A818..." }],
 *   "services": [{ "name": "MCP", "endpoint": "https://.../.well-known/agent-card.json" }],
 *   "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" }
 * ```
 *
 * The A2A card, with the skills, lives behind the `MCP` service endpoint. So
 * the record names where to find the agent, and the card says what it does.
 * Both shapes are typed here because a record written by someone else may be
 * the card itself.
 */
export type AgentRecord = {
  name?: string;
  description?: string;
  image?: string;
  /** ERC-8004 registration record: where to reach the agent. */
  services?: { name?: string; endpoint?: string }[];
  /** The record's own declared type, for example the EIP-8004 registration-v1 URL. */
  type?: string;
  /** A2A card: what the agent can do. Absent from a registration record. */
  url?: string;
  version?: string;
  skills?: { id?: string; name?: string; description?: string }[];
  registrations?: { agentId?: number | string; agentRegistry?: string }[];
  /** Everything as it came, for the operator who wants the raw record. */
  raw: string;
};

/** The endpoint a registration record points its agent card at, if it names one. */
export function agentCardUrl(record: AgentRecord): string | undefined {
  const service = record.services?.find((s) => /agent-card|\.well-known/i.test(s.endpoint ?? ""));
  return service?.endpoint ?? (typeof record.url === "string" ? record.url : undefined);
}

/** True when this is an ERC-8004 registration record rather than an A2A card. */
export function isRegistrationRecord(record: AgentRecord): boolean {
  return /eip-8004/i.test(record.type ?? "") || Array.isArray(record.services);
}

export type LoadedAgent = {
  owner: string;
  agentUri: string;
  /** Absent when the URI could not be read, with `problem` saying why. */
  record?: AgentRecord;
  problem?: string;
  /**
   * The A2A card the registration record points at, when it resolves. The
   * record says where to reach the agent; the card says what it can do, and
   * the two live in different places on purpose.
   */
  card?: AgentRecord;
  /** Why the card could not be read. Not a fault of the identity. */
  cardProblem?: string;
};

const DATA_JSON = /^data:application\/json;base64,/i;

/** Decodes a data URI, or fetches an http one. Never throws. */
export async function loadAgentRecord(
  agentUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ record?: AgentRecord; problem?: string }> {
  try {
    let text: string;
    if (DATA_JSON.test(agentUri)) {
      text = atob(agentUri.replace(DATA_JSON, ""));
    } else if (/^https?:/i.test(agentUri)) {
      const res = await fetchImpl(agentUri);
      if (!res.ok) {
        return {
          problem:
            `The record's URL answered ${res.status}. The on-chain record is still there and still names ` +
            `that URL; only the page behind it is missing.`,
        };
      }
      text = await res.text();
    } else {
      return { problem: `The record's URI is neither a data URI nor an http URL: ${agentUri.slice(0, 80)}` };
    }
    const json = JSON.parse(text) as Record<string, unknown>;
    return { record: { ...(json as AgentRecord), raw: text } };
  } catch (err) {
    // local-validation: decoding or parsing the card, never a relay call.
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Follows a registration record to its agent card, when it names one.
 *
 * Altana's own card is served from the docs site, which deploys from `main`,
 * so this 404s until the next release even though the on-chain record already
 * names the final URL. That is worth saying in those words rather than letting
 * a 404 look like a broken identity.
 */
export async function loadLinkedCard(
  record: AgentRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<{ card?: AgentRecord; cardProblem?: string }> {
  const url = agentCardUrl(record);
  if (!url || !/^https?:/i.test(url)) return {};
  const { record: card, problem } = await loadAgentRecord(url, fetchImpl);
  if (card) return { card };
  return {
    cardProblem:
      (problem ?? "the card could not be read") +
      " Altana's card is served from the docs site, which deploys from main, so it is missing until the next" +
      " release. The on-chain record already names the final URL, so nothing has to change on chain when it" +
      " goes live.",
  };
}

/** A minimal A2A-shaped record for a newly registered agent. */
export function draftAgentRecord(args: { name: string; description: string; url?: string }): string {
  const record = {
    name: args.name,
    description: args.description,
    ...(args.url ? { url: args.url } : {}),
    version: "1.0.0",
    // Empty on purpose: the id is not known until the mint assigns it, and
    // phase 2 of registration writes it back.
    registrations: [],
    skills: [],
  };
  return `data:application/json;base64,${btoa(JSON.stringify(record))}`;
}
