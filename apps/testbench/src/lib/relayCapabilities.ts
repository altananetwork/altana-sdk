/**
 * What a relay actually serves, asked of the relay.
 *
 * The presets carry a chain list so the page works before any probe answers,
 * but a hardcoded list goes stale: infra added Ethereum Sepolia to the local
 * relay, the preset still said "Celo only", and the walkthrough quietly
 * skipped the milestone's headline claim (qa, 2026-09-29). A list nobody
 * maintains is worse than no list, so the relay is asked.
 *
 * `wallet_getCapabilities` with no chain filter answers with every chain it
 * serves, keyed by hex id. With `[[]]` it answers nothing, which is a filter
 * for no chains rather than a filter for all of them.
 */

export type RelayProbe =
  | { status: "serving"; chainIds: number[] }
  | { status: "unreachable"; reason: string };

/** Asks the relay which chains it serves. Never throws. */
export async function probeRelay(
  relayUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<RelayProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(relayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getCapabilities", params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) return { status: "unreachable", reason: `the relay answered ${res.status}` };
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      return { status: "unreachable", reason: body.error.message ?? "the relay returned an error" };
    }
    const result = body.result;
    if (!result || typeof result !== "object") {
      return { status: "unreachable", reason: "the relay's capabilities were not an object" };
    }
    const chainIds = Object.keys(result)
      .map((key) => (key.startsWith("0x") ? parseInt(key, 16) : Number(key)))
      .filter((id) => Number.isInteger(id) && id > 0);
    return { status: "serving", chainIds };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `no answer within ${Math.round(timeoutMs / 1000)} seconds`
        : // local-validation: a fetch failure reaching the relay at all, not a response from it.
          err instanceof Error
          ? err.message
          : String(err);
    return { status: "unreachable", reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The chains to configure: those the relay serves and the bench has a config
 * for. A relay may serve chains the bench knows nothing about, such as BNB
 * testnet on the live testnet relay, and those are not ours to offer.
 */
export function servedAndKnown(probe: RelayProbe, known: readonly number[]): number[] {
  if (probe.status !== "serving") return [];
  return known.filter((id) => probe.chainIds.includes(id));
}

/** Chains the relay serves that the bench has no config for, named for the operator. */
export function servedButUnknown(probe: RelayProbe, known: readonly number[]): number[] {
  if (probe.status !== "serving") return [];
  return probe.chainIds.filter((id) => !known.includes(id));
}

/** True when the selection and what the relay serves disagree. */
export function selectionMatches(selected: readonly number[], served: readonly number[]): boolean {
  if (served.length === 0) return true;
  const a = [...selected].sort((x, y) => x - y).join(",");
  const b = [...served].sort((x, y) => x - y).join(",");
  return a === b;
}
