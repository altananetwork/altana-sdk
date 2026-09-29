/**
 * Reading an ERC-8004 identity record.
 *
 * The registry stores a URI, and the SDK writes it as a
 * `data:application/json;base64,…` so the record travels with the token and
 * needs no host. It can also be an ordinary URL, which is what the Altana
 * agent's record points at, so both are handled: the data URI is decoded in
 * the browser, and an http one is fetched.
 */

export type AgentRecord = {
  name?: string;
  description?: string;
  url?: string;
  version?: string;
  skills?: { id?: string; name?: string; description?: string }[];
  registrations?: { agentId?: number | string; agentRegistry?: string }[];
  /** Everything as it came, for the operator who wants the raw record. */
  raw: string;
};

export type LoadedAgent = {
  owner: string;
  agentUri: string;
  /** Absent when the URI could not be read, with `problem` saying why. */
  record?: AgentRecord;
  problem?: string;
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
    return { problem: err instanceof Error ? err.message : String(err) };
  }
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
