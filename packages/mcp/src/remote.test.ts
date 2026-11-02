import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleHttpRequest } from "./remote.js";

// The remote server over a real HTTP round trip, on an ephemeral port.
// Only network-free tools are called (about_altana); chain-reading tools
// are covered by their shared implementations' own tests.

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: handleHttpRequest });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function connectedClient(): Promise<Client> {
  const client = new Client({ name: "remote-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  await client.connect(transport);
  return client;
}

test("exposes exactly the read-only toolset, every tool annotated readOnlyHint", async () => {
  const client = await connectedClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "about_altana",
      "get_skill",
      "list_fee_currencies",
      "search_skills",
      "verify_authorization",
      "wallet_balance",
      "wallet_verification",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  } finally {
    await client.close();
  }
});

test("about_altana returns the positioning text", async () => {
  const client = await connectedClient();
  try {
    const result = await client.callTool({ name: "about_altana", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("KeyStore");
  } finally {
    await client.close();
  }
});

test("stateless: a second client connects independently", async () => {
  const a = await connectedClient();
  const b = await connectedClient();
  try {
    const [ra, rb] = await Promise.all([a.listTools(), b.listTools()]);
    expect(ra.tools.length).toBe(rb.tools.length);
  } finally {
    await a.close();
    await b.close();
  }
});

test("healthz reports the network and MCP endpoint", async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { name: string; mcpEndpoint: string; chainId: number };
  expect(body.name).toBe("altana-readonly");
  expect(body.mcpEndpoint).toBe("/mcp");
  expect(body.chainId).toBeGreaterThan(0);
});

test("unknown paths 404", async () => {
  const res = await fetch(`${baseUrl}/nope`);
  expect(res.status).toBe(404);
});
