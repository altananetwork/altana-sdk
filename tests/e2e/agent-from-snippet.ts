/**
 * Does the snippet the credential screen shows actually produce a working agent?
 *
 * Nothing tested this, and that is how it broke: the screen's snippet set
 * variables the MCP never read, while every test around it passed, because they
 * asserted the text contained the key and parsed as JSON. Proving the snippet
 * works needs an agent, an MCP server and a chain in one place, which is this.
 *
 * It builds the env the screen generates, launches a real @altananetwork/mcp with
 * exactly that, and asks it to spend inside the limit, over it, and after a
 * revoke. The key is passed in the environment and never in a tool call, because
 * a key pasted into a tool call goes to the agent's model provider.
 *
 *   scripts/fork/start.sh --with-relay
 *   set -a; source .fork/fork.env.out; set +a
 *   AGENT_RPC_URL=$FORK_RPC_URL AGENT_RELAY_URL=$ALTANA_RELAY_URL bun run agent:snippet
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClient,
  createHeadlessPasskey,
  keyHashForSessionOrKey,
  serializeSession,
  signerFromPrivateKey,
  BNB_TESTNET,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = process.env.AGENT_RPC_URL || BNB_TESTNET.publicRpcUrl;
const RELAY_URL = process.env.AGENT_RELAY_URL || BNB_TESTNET.relayUrl!;
const IS_FORK = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex | undefined;
if (!FUNDER_KEY) throw new Error("TEST_FUNDER_KEY is not set. Load the shared .env.testnet.");

const NETWORK: NetworkConfig = { ...BNB_TESTNET, publicRpcUrl: RPC_URL, relayUrl: RELAY_URL };
const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
const SESSION_NAME = "trading-bot";
const MCP_ENTRY = join(import.meta.dir, "..", "..", "packages", "mcp", "src", "index.ts");
const SANDBOX = await mkdtemp(join(tmpdir(), "altana-snippet-"));

const results: { id: string; what: string; pass: boolean; detail: string }[] = [];
const record = (id: string, what: string, pass: boolean, detail = "") => {
  results.push({ id, what, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${what}${detail ? `  ${detail}` : ""}`);
};
const step = (s: string) => console.log(`\n[${s}]`);

// ── The app's side: grant, and build the snippet ────────────────────────────

console.log("The credential screen's snippet, end to end");
console.log(`  mode   ${IS_FORK ? "anvil fork" : "LIVE chain 97"}`);

const client = createClient({ chains: [NETWORK] });
const publicClient = buildPublicClient(NETWORK);
if ((await publicClient.getChainId()) !== 97) throw new Error("expected chain 97");

const funder = privateKeyToAccount(FUNDER_KEY);
const passkey = createHeadlessPasskey();
const wallet = await client.createWallet({ signer: passkey });

step("the app creates a wallet, funds it and grants a permission");
const fundTx = await createWalletClient({
  account: funder,
  chain: bscTestnet,
  transport: http(RPC_URL),
}).sendTransaction({ to: wallet.address, value: parseEther("0.05") });
// Inclusion, not the receipt: the public RPC serves the block before the receipt.
for (let i = 0; i < 90; i++) {
  const r = await publicClient.getTransactionReceipt({ hash: fundTx }).catch(() => undefined);
  if (r) break;
  const t = await publicClient.getTransaction({ hash: fundTx }).catch(() => undefined);
  if (t?.blockNumber != null) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`  wallet ${wallet.address}`);

const secret = generatePrivateKey();
const session = await client.grantSession({
  wallet,
  signer: passkey,
  sessionSigner: signerFromPrivateKey(secret),
  permissions: { calls: [{ to: DEAD }], spend: [{ limit: parseEther("0.001"), period: "day" }] },
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
if (session.status !== "granted") throw new Error(`grant failed: ${session.status}`);
const keyHash = keyHashForSessionOrKey(session);

/**
 * Exactly what the credential screen puts on screen. If this and the screen ever
 * disagree, the screen is wrong, and that is the bug this file exists to catch.
 */
const SNIPPET_ENV = {
  ALTANA_SESSION: JSON.stringify(serializeSession(session)),
  ALTANA_SESSION_KEY: secret,
  ALTANA_SESSION_NAME: SESSION_NAME,
};
record(
  "S1",
  "the snippet carries the session and the key, and nothing else secret",
  SNIPPET_ENV.ALTANA_SESSION.includes(session.publicKey) &&
    !SNIPPET_ENV.ALTANA_SESSION.includes(secret.slice(2)),
  `${SNIPPET_ENV.ALTANA_SESSION.length} chars of session`,
);

// ── The agent's side: a real MCP, started with that env ─────────────────────

step("the agent starts an MCP with the snippet's environment and no admin key");
const proc = spawn("bun", ["run", MCP_ENTRY], {
  env: {
    ...process.env,
    ALTANA_CHAIN: "bnb-testnet",
    ...(IS_FORK ? { ALTANA_RPC_URL: RPC_URL, ALTANA_RELAY_URL: RELAY_URL } : {}),
    ...SNIPPET_ENV,
    // No admin key, and a sandbox so the real keychain and ~/.altana are untouched.
    ALTANA_WALLET_DEFAULT_PRIVATE_KEY: "",
    ALTANA_KEY_STORE: `file:${join(SANDBOX, "keys.json")}`,
    ALTANA_HOME: SANDBOX,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
proc.stderr!.on("data", (c: Buffer) => {
  stderr += c.toString();
});

let buf = "";
const responses = new Map<number, Record<string, unknown>>();
proc.stdout!.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.id != null) responses.set(Number(msg.id), msg);
    } catch {
      /* the server logs plain text to stderr, not here */
    }
  }
});

let nextId = 1;
function send(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const r = responses.get(id);
      if (r) {
        responses.delete(id);
        if (r.error) return reject(new Error(JSON.stringify(r.error)));
        return resolve(r.result);
      }
      if (Date.now() - start > 180_000) return reject(new Error(`${method} timed out`));
      setTimeout(tick, 200);
    };
    tick();
  });
}
async function call(name: string, args: unknown) {
  const result = await send("tools/call", { name, arguments: args }).catch((err: Error) => ({
    isError: true,
    content: [{ type: "text", text: err.message }],
  }));
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) return { ok: false, data: undefined as any, text };
  try {
    return { ok: true, data: JSON.parse(text), text };
  } catch {
    return { ok: true, data: undefined as any, text };
  }
}

let exitCode = 0;
try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "snippet", version: "0" },
  });
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  step("S2  the session is there without any tool call having carried the key");
  const listed = await call("list_sessions", {});
  const sawIt = JSON.stringify(listed.data ?? listed.text).includes(SESSION_NAME);
  record("S2", "list_sessions shows the session from the environment", sawIt, listed.text.slice(0, 140));
  record(
    "S3",
    "the key never appeared in a tool call",
    !JSON.stringify(listed.data ?? listed.text).includes(secret.slice(2)),
  );
  record(
    "S4",
    "the startup log names the session without printing its key",
    stderr.includes(SESSION_NAME) && !stderr.includes(secret.slice(2)),
    stderr.split("\n").find((l) => l.includes(SESSION_NAME))?.slice(0, 110) ?? "",
  );

  step("S5  the agent acts inside its limit, by name");
  const inside = await call("session_execute", {
    sessionName: SESSION_NAME,
    to: DEAD,
    valueEth: "0.0000001",
  });
  const hash = inside.data?.transactionHash ?? inside.data?.txHash;
  if (!inside.ok) console.log(`       ${inside.text.slice(0, 220)}`);
  record("S5", "the snippet produces a working agent", inside.ok && Boolean(hash), String(hash ?? inside.text.slice(0, 120)));

  step("S6  over the limit is refused");
  const over = await call("session_execute", { sessionName: SESSION_NAME, to: DEAD, valueEth: "0.01" });
  record(
    "S6",
    "the limit still binds an environment-loaded session",
    !over.ok || !(over.data?.transactionHash ?? over.data?.txHash),
    over.text.slice(0, 120),
  );

  step("S7  after the app revokes, the agent is refused");
  let revoke = await client.revokeSession({ wallet, signer: passkey, session });
  if (revoke.status !== "revoked") {
    revoke = await client.revokeSession({ wallet, signer: passkey, session });
  }
  record("S7", "the permission is revoked", revoke.status === "revoked", String(revoke.status));
  const after = await call("session_execute", { sessionName: SESSION_NAME, to: DEAD, valueEth: "0.0000001" });
  record(
    "S8",
    "the revoked agent is refused",
    !after.ok || !(after.data?.transactionHash ?? after.data?.txHash),
    after.text.slice(0, 120),
  );

  step("sweep  return the leftover to the funder");
  const left = await publicClient.getBalance({ address: wallet.address });
  const margin = parseEther("0.004");
  if (left > margin) {
    const s = await client.execute({
      wallet,
      signer: passkey,
      calls: { to: funder.address, value: left - margin, data: "0x" },
    });
    record("sweep", "leftover returned", String(s.status).toUpperCase() === "CONFIRMED", formatEther(left - margin));
  } else {
    record("sweep", "leftover returned", true, `only ${formatEther(left)} tBNB, below the fee margin`);
  }
} catch (err) {
  console.error("\nFAILED");
  console.error(err);
  console.error("\n--- server stderr ---\n" + stderr.slice(-1500));
  exitCode = 1;
} finally {
  proc.kill();
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
}

console.log("\n===========================================");
console.log(`${IS_FORK ? "FORK" : "LIVE"} snippet summary`);
console.log("===========================================");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(5)} ${r.what}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
console.log(`  keyHash ${keyHash}`);
process.exit(failed.length > 0 ? 1 : exitCode);
