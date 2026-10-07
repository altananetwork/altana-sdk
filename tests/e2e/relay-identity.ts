/**
 * Who the relay is, recorded by every run that talks to one.
 *
 * Not a check. A relay version is not a thing to be right or wrong, it is a
 * thing to know, and a check that failed on a version change would be noise on
 * the one day it mattered.
 *
 * It exists because of an evening spent on a refusal that stopped naming its
 * reason. QA measured the change between a morning run and an evening one, and
 * neither run had recorded which relay it spoke to, so "did the relay change
 * today" could not be answered from the record at all. One request before and
 * after, against an evening that cannot reconstruct it afterwards.
 *
 * Failing to reach the endpoint is recorded too and also does not fail anything:
 * a preflight that could not read a version has not established that anything is
 * wrong.
 */

/** What the relay says about itself, or why it could not be asked. */
export async function describeRelay(relayUrl: string): Promise<string> {
  const base = relayUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return `${base} (health returned ${res.status})`;
    const body = (await res.json()) as {
      version?: string;
      status?: string;
      quoteSigner?: string;
    };
    const parts = [
      body.version ? `version ${body.version}` : "no version field",
      body.status ? `status ${body.status}` : undefined,
      body.quoteSigner ? `quoteSigner ${body.quoteSigner.slice(0, 12)}` : undefined,
    ].filter(Boolean);
    return `${base}  ${parts.join(", ")}`;
  } catch (err) {
    /* A local relay on a fork has no /health, and that is not a problem with the
       run. Say what happened and carry on. */
    return `${base} (could not read /health: ${(err as Error).message.slice(0, 60)})`;
  }
}

/** Print it under a run's header. Never throws. */
export async function logRelayIdentity(relayUrl: string): Promise<void> {
  console.log(`  relay  ${await describeRelay(relayUrl).catch(() => relayUrl)}`);
}
