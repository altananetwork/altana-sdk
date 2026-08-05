/**
 * Single source of truth for the version this server advertises to MCP hosts.
 *
 * Read from package.json rather than repeated as a literal: the hand-maintained
 * copy had already drifted (0.1.0 advertised against a published 0.2.0), which
 * an AI host has no way to notice.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
