/**
 * Does the snippet the credential screen shows actually produce a working agent?
 *
 * Nothing tested this, and that is how it broke: the screen's snippet set
 * variables the MCP never read, while every test around it passed, because they
 * asserted the text contained the key and parsed as JSON. Proving the snippet
 * works needs an agent, an MCP server and a chain in one place, which is this.
 *
 * It does not build the environment itself any more, because building it here
 * was one assumption away from the screen and that gap is the whole bug. It
 * imports the app's own `buildMcpEnv` and `buildSnippet`, renders the Claude
 * Code command the screen prints, and runs that command through bash with
 * `claude mcp add` replaced by a stand-in that does what Claude Code does with
 * those arguments. So the shell quoting is exercised for real: ALTANA_SESSION is
 * JSON, and unquoted its braces and quotes do not survive a shell.
 *
 * Then it asks the resulting agent to spend inside the limit, over it, and after
 * a revoke. The key travels in the environment and never in a tool call, because
 * a key pasted into a tool call goes to the agent's model provider.
 *
 *   scripts/fork/start.sh --with-relay
 *   set -a; source .fork/fork.env.out; set +a
 *   AGENT_RPC_URL=$FORK_RPC_URL AGENT_RELAY_URL=$ALTANA_RELAY_URL bun run agent:snippet
 *
 * ALTANA_APP_DIR points at the wallet app checkout holding lib/agent-setup.ts.
 */

import { spawn } from "node:child_process";
import { createChecks } from "./checks.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const MCP_ADD_STUB = join(import.meta.dir, "mcp-add-stub.ts");
const SANDBOX = await mkdtemp(join(tmpdir(), "altana-snippet-"));
/* Outside the sandbox on purpose: the sandbox is deleted in the finally, and a
   log that is removed before anyone reads it is worse than no log, because the
   path is printed and then does not exist. */
const SANDBOX_LOG_DIR = await mkdtemp(join(tmpdir(), "altana-snippet-log-"));
const STUB_ECHO = join(SANDBOX, "received.json");

/* The app's snippet generator, imported from the wallet app rather than
   reimplemented here.

   This is the point of the file. A copy of these strings living in this repo
   would pass forever while the screen printed something else, which is the
   state this test was written to end. The path is a pointer across two repos, so
   it is loud when wrong rather than quietly falling back to a local copy. */
type SetupInput = {
  secret: string;
  serialized: string;
  walletAddress: string;
  sessionName: string;
};
type AgentSetup = {
  buildMcpEnv: (input: SetupInput) => Record<string, string>;
  buildSnippet: (target: "claude-code", input: SetupInput) => string;
};
const APP_DIR =
  process.env.ALTANA_APP_DIR ?? join(import.meta.dir, "..", "..", "..", "altana-wallet");
const AGENT_SETUP = join(APP_DIR, "lib", "agent-setup.ts");
const appSetup = (await import(AGENT_SETUP).catch((err: Error) => {
  throw new Error(
    `cannot read the app's snippet generator at ${AGENT_SETUP}. ` +
      `Set ALTANA_APP_DIR to a wallet app checkout that has it. (${err.message})`,
  );
})) as AgentSetup;
for (const name of ["buildMcpEnv", "buildSnippet"] as const) {
  if (typeof appSetup[name] !== "function") {
    throw new Error(`${AGENT_SETUP} does not export ${name}. Nothing below would be testing the app.`);
  }
}

/* Checks that refuse to run when the thing they are about was never created.
   A check evaluated after the step that makes its subject failed is how a
   passing assertion ends up printed two lines under the failure that made it
   impossible. See tests/e2e/checks.ts. */
const checks = createChecks();
const record = checks.record.bind(checks);
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

/* The screen's own inputs, and the screen's own output. Nothing below restates
   either of them. */
const setupInput: SetupInput = {
  secret,
  serialized: JSON.stringify(serializeSession(session)),
  walletAddress: wallet.address,
  sessionName: SESSION_NAME,
};
const SNIPPET_ENV = appSetup.buildMcpEnv(setupInput);
record(
  "S1",
  "the screen's environment carries the session and the key, and nothing else secret",
  Object.values(SNIPPET_ENV).some((v) => v.includes(session.publicKey)) &&
    Object.entries(SNIPPET_ENV).every(
      ([k, v]) => k === "ALTANA_SESSION_KEY" || !v.includes(secret.slice(2)),
    ),
  Object.keys(SNIPPET_ENV).join(" "),
);

/* The Claude Code command exactly as rendered, with two substitutions and no
   others, each one a thing that cannot exist on this machine:

   - `claude mcp add` becomes the stand-in, because Claude Code is not what is
     under test; what it does with these arguments is.
   - `bunx @altananetwork/mcp` becomes the server in this repo, because the
     version that can import a session is not published. That is the same gate
     that keeps mcpSessionImportVersion null on the screen.

   Everything between them, every quote and every value, is the screen's. */
const rendered = appSetup.buildSnippet("claude-code", setupInput);
const PUBLISHED_MCP = /bunx @altananetwork\/mcp(@[\w.-]+)?\s*$/m;
if (!PUBLISHED_MCP.test(rendered)) {
  throw new Error(`the rendered command does not end in a bunx @altananetwork/mcp:\n${rendered}`);
}
const sq = (v: string) => `'${v.split("'").join("'\\''")}'`;
const launchCommand = rendered
  .replace(/^claude mcp add /, `bun ${sq(MCP_ADD_STUB)} `)
  .replace(PUBLISHED_MCP, `bun ${sq(MCP_ENTRY)}`);
console.log(`  app    ${AGENT_SETUP}`);

// ── The agent's side: a real MCP, started with that env ─────────────────────

step("the agent pastes the command into a shell");
console.log(launchCommand.split("\n").map((l) => `    ${l}`).join("\n"));

/* The snippet's variables are deliberately absent from this environment. They
   reach the server only by surviving the command line, which is the thing under
   test; inherited copies would hide a quoting failure completely. */
const shellEnv: Record<string, string | undefined> = { ...process.env };
for (const name of Object.keys(SNIPPET_ENV)) delete shellEnv[name];

const proc = spawn("bash", ["-c", launchCommand], {
  env: {
    ...shellEnv,
    ...(IS_FORK ? { ALTANA_RPC_URL: RPC_URL, ALTANA_RELAY_URL: RELAY_URL } : {}),
    // No admin key, and a sandbox so the real keychain and ~/.altana are untouched.
    ALTANA_WALLET_DEFAULT_PRIVATE_KEY: "",
    ALTANA_KEY_STORE: `file:${join(SANDBOX, "keys.json")}`,
    ALTANA_HOME: SANDBOX,
    ALTANA_STUB_ECHO: STUB_ECHO,
  },
  // Its own group, so the shell, the stand-in and the server all go at teardown.
  detached: true,
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

  step("S2  what the server process received is what the screen rendered");
  const received = JSON.parse(await readFile(STUB_ECHO, "utf8")) as {
    env: Record<string, string>;
    command: string[];
  };
  const mismatched = Object.entries(SNIPPET_ENV).filter(([k, v]) => received.env[k] !== v);
  record(
    "S2",
    "every value survived the shell byte for byte",
    mismatched.length === 0 && Object.keys(received.env).length === Object.keys(SNIPPET_ENV).length,
    mismatched.length === 0
      ? `${Object.keys(received.env).length} variables`
      : `mangled: ${mismatched.map(([k]) => k).join(", ")}`,
  );

  step("S3  the session is there without any tool call having carried the key");
  const listed = await call("list_sessions", {});
  const sawIt = JSON.stringify(listed.data ?? listed.text).includes(SESSION_NAME);
  record("S3", "list_sessions shows the session from the environment", sawIt, listed.text.slice(0, 140));
  record(
    "S4",
    "the key never appeared in a tool call",
    !JSON.stringify(listed.data ?? listed.text).includes(secret.slice(2)),
  );
  record(
    "S5",
    "the startup log names the session without printing its key",
    stderr.includes(SESSION_NAME) && !stderr.includes(secret.slice(2)),
    stderr.split("\n").find((l) => l.includes(SESSION_NAME))?.slice(0, 110) ?? "",
  );

  /* From here every check needs the session to have loaded. Without it the
     agent does not exist, and "the agent was refused" is true of a server that
     never had a permission at all, which is the reading that must not be
     available. */
  step("S6  the agent acts inside its limit, by name");
  await checks.step("S6", "the snippet produces a working agent", ["S3"], async () => {
    const inside = await call("session_execute", {
      sessionName: SESSION_NAME,
      to: DEAD,
      valueEth: "0.0000001",
    });
    const hash = inside.data?.transactionHash ?? inside.data?.txHash;
    if (!inside.ok) console.log(`       ${inside.text.slice(0, 220)}`);
    return { pass: inside.ok && Boolean(hash), detail: String(hash ?? inside.text.slice(0, 120)) };
  });

  step("S7  over the limit is refused");
  /* Needs S6, not just S3. A refusal only proves the limit binds if a spend
     under it was shown to land first; otherwise everything is refused and the
     check passes for the wrong reason. */
  await checks.step("S7", "the limit still binds an environment-loaded session", ["S6"], async () => {
    const over = await call("session_execute", { sessionName: SESSION_NAME, to: DEAD, valueEth: "0.01" });
    return {
      pass: !over.ok || !(over.data?.transactionHash ?? over.data?.txHash),
      detail: over.text.slice(0, 120),
    };
  });

  step("S8  after the app revokes, the agent is refused");
  await checks.step("S8", "the permission is revoked", ["S3"], async () => {
    let revoke = await client.revokeSession({ wallet, signer: passkey, session });
    if (revoke.status !== "revoked") {
      revoke = await client.revokeSession({ wallet, signer: passkey, session });
    }
    return { pass: revoke.status === "revoked", detail: String(revoke.status) };
  });
  /* Needs both: a revoke that did not happen, and a spend that never worked,
     each produce a refusal that looks like proof the revoke bit. */
  await checks.step("S9", "the revoked agent is refused", ["S6", "S8"], async () => {
    const after = await call("session_execute", { sessionName: SESSION_NAME, to: DEAD, valueEth: "0.0000001" });
    return {
      pass: !after.ok || !(after.data?.transactionHash ?? after.data?.txHash),
      detail: after.text.slice(0, 120),
    };
  });

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
  /* The whole server log, to a file, rather than its last 1500 characters to
     the terminal. A tail is whatever the server said most recently, which is
     not necessarily anything to do with the failure above, and reading one as
     the other cost a day. Said explicitly for the same reason. */
  const logPath = join(SANDBOX_LOG_DIR, "mcp-server.log");
  await writeFile(logPath, stderr).catch(() => {});
  console.error(`\n  the server's full log is at ${logPath}`);
  console.error("  it is what the server said, not necessarily why this failed");
  exitCode = 1;
} finally {
  // The group, not just bash: the server is two processes down from it.
  try {
    if (proc.pid) process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
}

const summaryCode = checks.summarise(`${IS_FORK ? "FORK" : "LIVE"} snippet summary`);
console.log(`  keyHash ${keyHash}`);
process.exit(summaryCode || exitCode);
