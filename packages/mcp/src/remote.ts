#!/usr/bin/env bun
/**
 * Altana remote MCP server — read-only.
 *
 * The hosted, directory-listable counterpart to the stdio server in
 * index.ts. Serves the Model Context Protocol over Streamable HTTP on a
 * public endpoint, exposing only tools that read public on-chain or relay
 * state. It holds NO key material and NO per-user state: no wallet keys,
 * no session keys, no keychain, nothing to custody. Executing transactions
 * and granting sessions stay with the local stdio server, where keys live
 * in the user's own OS keychain.
 *
 * Tools (every one annotated readOnlyHint):
 *   - Identity: about_altana
 *   - Verify:   wallet_verification, verify_authorization
 *   - Inspect:  wallet_balance (by address), list_fee_currencies
 *   - Skills:   search_skills, get_skill
 *
 * Transport is stateless (no MCP session ids): each POST gets a fresh
 * server + transport pair, so any number of instances can sit behind a
 * load balancer. Chain selection matches index.ts: one process serves one
 * chain, picked via ALTANA_CHAIN at startup. `PORT` picks the listen port
 * (default 3717); the MCP endpoint is `/mcp`, with `/healthz` for probes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createPublicClient, http, type PublicClient } from "viem";
import { createClient } from "@altananetwork/sdk";
import { VERSION } from "./version.js";
import { formatBalance } from "./balanceFormat.js";
import { SUPPORTED_CHAINS, describeNetwork, resolveNetwork } from "./network.js";
import { feeCurrenciesPayload } from "./feeCurrencies.js";
import { searchSkills, getSkill } from "./skills.js";
import {
  ABOUT_ALTANA,
  SERVER_INSTRUCTIONS,
  assertAddress,
  assertBytes32,
  readAuthorization,
  readWalletVerification,
  type KeyStoreReadContext,
} from "./keystoreRead.js";

// ---------- network ---------------------------------------------------------

const resolved = resolveNetwork(process.env.ALTANA_CHAIN);
const NETWORK = resolved.network;
const REGISTRY = resolved.registry;
if (!resolved.recognized) {
  console.error(
    `[altana-mcp-remote] Unknown ALTANA_CHAIN="${resolved.requested}". ` +
      `Supported: ${SUPPORTED_CHAINS}. Falling back to bnb.`,
  );
}

const client = createClient({ chains: [NETWORK] });
const publicClient = createPublicClient({
  chain: NETWORK.chain,
  transport: http(NETWORK.publicRpcUrl),
});
const registryClient =
  REGISTRY === NETWORK
    ? publicClient
    : createPublicClient({ chain: REGISTRY.chain, transport: http(REGISTRY.publicRpcUrl) });

const READ_CTX: KeyStoreReadContext = {
  network: NETWORK,
  registry: REGISTRY,
  publicClient: publicClient as PublicClient,
  registryClient: registryClient as PublicClient,
};

// ---------- server ----------------------------------------------------------

const REMOTE_INSTRUCTIONS =
  SERVER_INSTRUCTIONS +
  ` This hosted endpoint is read-only: it verifies authority, reads balances and discovers certified skills, and holds no keys. Creating wallets, granting sessions and executing transactions happen in the local \`@altananetwork/mcp\` stdio server, where keys stay in the user's own OS keychain.`;

/** Marks a tool as a pure read for hosts that honor MCP tool annotations. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function jsonContent(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** Build a fresh read-only MCP server (one per request in stateless mode). */
export function createReadonlyServer(): McpServer {
  const server = new McpServer(
    {
      name: "altana-readonly",
      version: VERSION,
    },
    {
      instructions: REMOTE_INSTRUCTIONS,
    },
  );

  // Same TS2589 workaround as index.ts: registerTool's generics exceed
  // inference depth across many calls, so we cast and hand-validate inputs.
  const tool = (server as unknown as {
    registerTool: (name: string, config: any, cb: any) => unknown;
  }).registerTool.bind(server);

  tool(
    "about_altana",
    {
      title: "About Altana Smart Agentic Wallet",
      description:
        "Return the positioning and capability summary for Altana Smart " +
        "Agentic Wallet. Use this when a user asks what Altana is, how it differs " +
        "from other agentic wallet stacks, or why an AI host would integrate it.",
      annotations: READ_ONLY,
    },
    async () => ({ content: [{ type: "text", text: ABOUT_ALTANA }] }),
  );

  tool(
    "wallet_verification",
    {
      title: "Verify wallet authorities via KeyStore",
      description:
        "Read the on-chain KeyStore registry for any wallet address. Returns " +
        "every authorized key + its public key bytes. This is how agents and " +
        "tools verify wallet authority without contacting the wallet owner.",
      inputSchema: { address: z.string() },
      annotations: READ_ONLY,
    },
    async ({ address }: { address: string }) =>
      jsonContent(await readWalletVerification(READ_CTX, address)),
  );

  tool(
    "verify_authorization",
    {
      title: "Verify authorization",
      description:
        "Ask KeyStore whether a key is currently authorized on a wallet. " +
        "Returns a boolean plus the keyId that was checked. Note: this reads " +
        "the public KeyStore registry — a session granted with register: false " +
        "works on-chain but reports false here until it is registered. On an " +
        "L2 the registry lives on the L1; `authorized` is read there and a " +
        "`cache` block reports what the L2 KeyStoreCache holds (`fresh` is " +
        "the cache's own isValidKey).",
      inputSchema: {
        walletAddress: z.string(),
        keyId: z.string(),
      },
      annotations: READ_ONLY,
    },
    async ({ walletAddress, keyId }: { walletAddress: string; keyId: string }) => {
      const addr = assertAddress(walletAddress);
      const id = assertBytes32(keyId);
      const result = await readAuthorization(READ_CTX, addr, id);
      return jsonContent({
        walletAddress: addr,
        keyId: id,
        ...(REGISTRY !== NETWORK ? { registryNetwork: REGISTRY.chain.name } : {}),
        ...result,
      });
    },
  );

  tool(
    "wallet_balance",
    {
      title: "Wallet balance",
      description:
        "Native token balance for any wallet address. Pass `tokens` (ERC-20 " +
        "addresses) to include specific token balances, or `discover: true` to " +
        "list every ERC-20 the wallet holds (discovered through the Altana relay, " +
        "zero balances omitted) — the result then carries `discovered: true`. " +
        "Use `tokens` or `discover`, not both.",
      inputSchema: {
        address: z.string(),
        tokens: z.array(z.string()).optional(),
        discover: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({
      address,
      tokens,
      discover,
    }: {
      address: string;
      tokens?: string[];
      discover?: boolean;
    }) => {
      if (discover && tokens !== undefined) {
        throw new Error(
          "wallet_balance: pass either `tokens` (explicit ERC-20 list) or `discover: true` (list what the wallet holds), not both.",
        );
      }
      const addr = assertAddress(address);
      const formatted = discover
        ? await client.holdings({ wallet: addr }).then((res) =>
            formatBalance({
              name: addr,
              address: addr,
              native: res.native,
              tokens: res.tokens,
              discovered: true,
            }),
          )
        : await client
            .balances({
              wallet: addr,
              ...(tokens !== undefined ? { tokens: tokens.map(assertAddress) } : {}),
            })
            .then((res) =>
              formatBalance({
                name: addr,
                address: addr,
                native: res.native,
                ...(res.tokens !== undefined ? { tokens: res.tokens } : {}),
              }),
            );
      // The stdio payload's `name` is a local wallet name; there are no
      // named wallets on the remote server, so drop it.
      const { name: _name, ...payload } = formatted;
      return jsonContent(payload);
    },
  );

  tool(
    "list_fee_currencies",
    {
      title: "List relay fee currencies",
      description:
        "List the tokens the Altana relay accepts as payment for its fee on " +
        "the selected chain, with the rate each is priced at right now. The " +
        "relay charges whichever accepted token the wallet holds, so a wallet " +
        "funded with any listed token can execute without the native token.",
      annotations: READ_ONLY,
    },
    async () => {
      const listed = await client.feeCurrencies();
      return jsonContent(feeCurrenciesPayload(listed, NETWORK.chain.nativeCurrency.symbol));
    },
  );

  tool(
    "search_skills",
    {
      title: "Find a certified skill",
      description:
        "Find certified protocol skills (trading, lending, payments) an " +
        "Altana wallet's agent can use on chain. Returns matching skills with " +
        "their scope and certification scorecard; then call get_skill for the " +
        "one you want to run.",
      inputSchema: { query: z.string() },
      annotations: READ_ONLY,
    },
    async ({ query }: { query: string }) => {
      const matches = await searchSkills(query);
      return jsonContent({
        query,
        count: matches.length,
        matches,
        note:
          matches.length > 0
            ? "Call get_skill with a match's id to fetch its verified SKILL.md playbook before acting."
            : "No certified skills matched. Try broader terms (e.g. a protocol or action name).",
      });
    },
  );

  tool(
    "get_skill",
    {
      title: "Get a certified skill",
      description:
        "Fetch the full SKILL.md playbook for one certified skill by id (from " +
        "search_skills). The content is integrity-checked against the " +
        "registry's sha256 before being returned. Also returns the skill's " +
        "scope (allowed contracts, suggested spend cap) and certification " +
        "scorecard.",
      inputSchema: {
        id: z.string().describe('The skill id, e.g. "pancakeswap-trading"'),
      },
      annotations: READ_ONLY,
    },
    async ({ id }: { id: string }) => jsonContent(await getSkill(id)),
  );

  return server;
}

// ---------- HTTP ------------------------------------------------------------

/**
 * Handle one MCP-over-HTTP request. Stateless: a fresh server + transport
 * pair per request, torn down when the response finishes.
 */
export async function handleMcpRequest(req: Request): Promise<Response> {
  const server = createReadonlyServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export function handleHttpRequest(req: Request): Promise<Response> | Response {
  const url = new URL(req.url);
  if (url.pathname === "/mcp") return handleMcpRequest(req);
  if (url.pathname === "/" || url.pathname === "/healthz") {
    return Response.json({
      name: "altana-readonly",
      version: VERSION,
      network: NETWORK.chain.name,
      chainId: NETWORK.chainId,
      mcpEndpoint: "/mcp",
      docs: "https://docs.altana.network",
    });
  }
  return new Response("Not found", { status: 404 });
}

// The repo typechecks without bun-types, so declare the two Bun globals we
// touch. `bun test` and the runtime see the real implementations.
declare const Bun: {
  serve(options: {
    port: number;
    fetch: (req: Request) => Response | Promise<Response>;
  }): unknown;
};

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const port = Number(process.env.PORT ?? 3717);
  Bun.serve({ port, fetch: handleHttpRequest });
  console.error(
    `[altana-mcp-remote] read-only MCP on http://localhost:${port}/mcp — network: ${describeNetwork(NETWORK)}`,
  );
}
