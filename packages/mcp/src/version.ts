/**
 * Single source of truth for the version this server advertises to MCP hosts.
 *
 * Read from package.json rather than repeated as a literal: a hand-maintained
 * copy drifts on the next release and an AI host asking what version it is
 * talking to gets a stale answer, silently.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
