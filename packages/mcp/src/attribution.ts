/**
 * The attribution tag (ERC-8021) this server's transactions carry.
 *
 * The SDK puts a short public tag on each transaction naming the app that
 * sent it. Through this server that is `altana,altana_mcp`, plus the agent
 * builder's own code when they set one:
 *
 *   - `ALTANA_APP_CODE=my_agent` adds `my_agent` (several, comma separated),
 *   - `ALTANA_ATTRIBUTION=off` (or `false`, `0`, `no`) sends no tag at all.
 */
import { attributionCodes, type AttributionOptions } from "@altananetwork/sdk";

/** The code every transaction sent through this server carries. */
export const MCP_CODE = "altana_mcp";

export type McpAttribution = {
  /** What to hand to `createClient`. */
  options: AttributionOptions;
  /** A code in `ALTANA_APP_CODE` that cannot be used, left out. */
  rejected?: string;
};

/**
 * The client's attribution options from the environment. A code that cannot
 * be used is reported and left out, never thrown: a typo in an environment
 * variable should not stop the server from starting.
 */
export function attributionFromEnv(env: { ALTANA_APP_CODE?: string | undefined; ALTANA_ATTRIBUTION?: string | undefined }): McpAttribution {
  if (/^(off|false|0|no)$/i.test((env.ALTANA_ATTRIBUTION ?? "").trim())) return { options: { attribution: false } };
  const own = (env.ALTANA_APP_CODE ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  for (const code of own) {
    try {
      attributionCodes(code);
    } catch {
      return { options: { appCode: [MCP_CODE] }, rejected: code };
    }
  }
  return { options: { appCode: [MCP_CODE, ...own] } };
}
