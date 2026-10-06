/**
 * The agent half of the wallet flow, driven through the real MCP server.
 *
 * This is the part the app cannot test for itself. The app grants a permission
 * and shows the session key once; what happens next happens in somebody's
 * agent, on another machine, with no admin key anywhere near it. So this script
 * plays both sides: it does what the UI does, then hands the two halves to a
 * real `@altananetwork/mcp` process over stdio exactly as a person pasting them
 * would, and checks the agent can act, is refused when it exceeds its limit, and
 * is refused again after the permission is revoked.
 *
 *   create a passkey wallet -> fund -> grant   (the app's side)
 *   import_session -> session_execute          (the agent's side, via MCP)
 *   over the limit -> refused
 *   revoke -> session_execute -> refused
 *
 * Fork or live, chosen entirely by env, so the same script produces both proofs:
 *
 *   # fork, with a local relay
 *   scripts/fork/start.sh --with-relay
 *   set -a; source .fork/fork.env.out; set +a
 *   AGENT_RPC_URL=$FORK_RPC_URL AGENT_RELAY_URL=$ALTANA_RELAY_URL bun run agent-via-mcp.ts
 *
 *   # live chain 97
 *   bun run agent-via-mcp.ts
 *
 * Needs TEST_FUNDER_KEY from the shared .env.testnet. The key is never printed.
 *
 * The MCP is pointed at a temporary key store and a temporary ALTANA_HOME, so a
 * run never touches the real OS keychain or a real ~/.altana. That matters on a
 * shared machine: importing a session into somebody's actual login keychain
 * leaves real entries behind, and on macOS it can raise an access prompt no
 * unattended run can answer. The directory is removed when the run ends.
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
const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;
const DAILY_CAP = parseEther("0.001");
const SESSION_NAME = `app-granted-${Date.now()}`;
const MCP_ENTRY = join(import.meta.dir, "..", "..", "packages", "mcp", "src", "index.ts");

/** Throwaway key and metadata storage for this run, removed at the end. */
const SANDBOX = await mkdtemp(join(tmpdir(), "altana-agent-mcp-"));

const results: { id: string; what: string; pass: boolean; detail: string }[] = [];
const record = (id: string, what: string, pass: boolean, detail = "") => {
  results.push({ id, what, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id.padEnd(5)} ${what}${detail ? `  ${detail}` : ""}`);
};
const step = (s: string) => console.log(`\n[${s}]`);
const info = (k: string, v: unknown) => console.log(`  ${k.padEnd(16)}${v}`);

// ── The app's side ──────────────────────────────────────────────────────────

console.log("The agent half, through the real MCP server");
console.log("==========================================");
info("mode", IS_FORK ? "anvil fork" : "LIVE chain 97");
info("rpc", RPC_URL);
info("relay", RELAY_URL);
info("key store", `${SANDBOX} (temporary, removed at the end)`);

const publicClient = buildPublicClient(NETWORK);
const chainId = await publicClient.getChainId();
if (chainId !== 97) throw new Error(`expected chain 97, got ${chainId}`);

const client = createClient({ chains: [NETWORK] });
const funder = privateKeyToAccount(FUNDER_KEY);
const funderClient = createWalletClient({
  account: funder,
  chain: bscTestnet,
  transport: http(RPC_URL),
});

step("the app creates a wallet, funds it, and grants a permission");
const passkey = createHeadlessPasskey();
const wallet = await client.createWallet({ signer: passkey });
info("wallet", wallet.address);

const fundTx = await funderClient.sendTransaction({ to: wallet.address, value: parseEther("0.02") });
await publicClient.waitForTransactionReceipt({ hash: fundTx });
info("funded", `0.02 tBNB  ${fundTx}`);

// The session key the app generates and shows exactly once.
const secret = generatePrivateKey();
const session = await client.grantSession({
  wallet,
  signer: passkey,
  sessionSigner: signerFromPrivateKey(secret),
  permissions: { calls: [{ to: RECIPIENT }], spend: [{ limit: DAILY_CAP, period: "day" }] },
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
if (session.status !== "granted") throw new Error(`grant failed: ${session.status}`);
const keyHash = keyHashForSessionOrKey(session);
info("granted", `keyHash ${keyHash.slice(0, 18)}`);

// Exactly what the app puts on the credential screen: the stored half, which
// carries no key material, and the key, shown once.
const serialized = JSON.stringify(serializeSession(session));
record("A1", "the serialized half carries no private key", !serialized.includes(secret.slice(2)));

// ── The agent's side, over stdio ────────────────────────────────────────────

step("the agent starts an MCP server with no admin key at all");
const proc = spawn("bun", ["run", MCP_ENTRY], {
  env: {
    ...process.env,
    ALTANA_CHAIN: "bnb-testnet",
    ...(IS_FORK ? { ALTANA_RPC_URL: RPC_URL, ALTANA_RELAY_URL: RELAY_URL } : {}),
    // Keep the run out of the real OS keychain and the real ~/.altana. Without
    // these, importing a session would leave entries in somebody's login
    // keychain, and on macOS could raise a prompt nothing can answer.
    ALTANA_KEY_STORE: `file:${join(SANDBOX, "keys.json")}`,
    ALTANA_HOME: SANDBOX,
    // Deliberately absent: ALTANA_WALLET_DEFAULT_PRIVATE_KEY. An agent machine
    // has no admin key, which is the whole point of importing a session.
    ALTANA_WALLET_DEFAULT_PRIVATE_KEY: "",
  },
  stdio: ["pipe", "pipe", "inherit"],
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
      /* the server also logs plain text */
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

/** A tool call. Returns { ok, data } rather than throwing, since a refusal is a result. */
async function call(name: string, args: unknown): Promise<{ ok: boolean; data: any; text: string }> {
  const result = await send("tools/call", { name, arguments: args }).catch((err: Error) => ({
    isError: true,
    content: [{ type: "text", text: err.message }],
  }));
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) return { ok: false, data: undefined, text };
  try {
    return { ok: true, data: JSON.parse(text), text };
  } catch {
    return { ok: true, data: undefined, text };
  }
}

let exitCode = 0;
try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agent-via-mcp", version: "0" },
  });
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  step("A2  import_session: the pasted session becomes usable by name");
  const imported = await call("import_session", {
    sessionName: SESSION_NAME,
    session: serialized,
    privateKey: secret,
  });
  if (!imported.ok) console.log(`       ${imported.text.slice(0, 200)}`);
  info("keyHash", imported.data?.keyHash);
  record(
    "A2",
    "the imported session reaches the same on-chain key hash as the grant",
    imported.ok && imported.data?.keyHash?.toLowerCase() === keyHash.toLowerCase(),
    imported.ok ? `${imported.data?.sessionName}` : imported.text.slice(0, 120),
  );

  step("A3  the agent acts inside its limit");
  const inside = await call("session_execute", {
    sessionName: SESSION_NAME,
    to: RECIPIENT,
    valueEth: "0.0000001",
  });
  if (!inside.ok) console.log(`       ${inside.text.slice(0, 300)}`);
  const insideHash = inside.data?.transactionHash ?? inside.data?.txHash;
  info("tx", insideHash);
  record("A3", "the agent's transaction lands", inside.ok && Boolean(insideHash), String(insideHash ?? inside.text.slice(0, 120)));

  step("A4  a spend over the limit is refused");
  const over = await call("session_execute", {
    sessionName: SESSION_NAME,
    to: RECIPIENT,
    valueEth: "0.01",
  });
  record(
    "A4",
    "the over-limit spend is refused",
    !over.ok || !(over.data?.transactionHash ?? over.data?.txHash),
    over.text.slice(0, 140),
  );

  step("A5  the app revokes, and the agent is refused");
  // Retried once, and the retry is reported rather than hidden. The live relay
  // does occasionally fail a bundle for reasons that have nothing to do with
  // what is under test, and a suite that silently retries teaches you to
  // distrust it while one that fails on a blip gets ignored.
  let revoke = await client.revokeSession({ wallet, signer: passkey, session });
  if (revoke.status !== "revoked") {
    info("revoke", `${revoke.status}, retrying once`);
    revoke = await client.revokeSession({ wallet, signer: passkey, session });
    info("retry", revoke.status);
  } else {
    info("revoke", revoke.status);
  }
  record(
    "A5",
    "the permission is revoked",
    revoke.status === "revoked",
    String(revoke.status),
  );

  const after = await call("session_execute", {
    sessionName: SESSION_NAME,
    to: RECIPIENT,
    valueEth: "0.0000001",
  });
  record(
    "A6",
    "the revoked agent is refused",
    !after.ok || !(after.data?.transactionHash ?? after.data?.txHash),
    after.text.slice(0, 140),
  );

  step("sweep  return the leftover tBNB to the funder");
  const leftover = await publicClient.getBalance({ address: wallet.address });
  const margin = parseEther("0.004");
  if (leftover > margin) {
    const sweep = await client.execute({
      wallet,
      signer: passkey,
      calls: { to: funder.address, value: leftover - margin, data: "0x" },
    });
    record("sweep", "leftover returned to the funder", String(sweep.status).toUpperCase() === "CONFIRMED", `${formatEther(leftover - margin)} tBNB`);
  } else {
    record("sweep", "leftover returned to the funder", true, `only ${formatEther(leftover)} tBNB, below the fee margin`);
  }
} catch (err) {
  console.error("\nFAILED");
  console.error(err);
  exitCode = 1;
} finally {
  proc.kill();
  // Everything the MCP stored went into the sandbox, so removing the directory
  // is the whole cleanup. Nothing was written to the real keychain to undo.
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
}

console.log("\n==========================================");
console.log(`${IS_FORK ? "FORK" : "LIVE"} agent-via-MCP summary`);
console.log("==========================================");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(5)} ${r.what}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
if (!IS_FORK) console.log(`\n  wallet  https://testnet.bscscan.com/address/${wallet.address}`);
process.exit(failed.length > 0 ? 1 : exitCode);
