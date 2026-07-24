/**
 * MCP server smoke test — drives the server over stdio with raw JSON-RPC,
 * exercises the full Path B session flow:
 *
 *   1. wallet_balance  (sanity: admin wallet has funds)
 *   2. grant_session   (admin authorizes a fresh session on-chain)
 *   3. wallet_verification (confirm session is now in KeyStore)
 *   4. session_execute (agent path: session signs and submits)
 *   5. revoke_session  (admin pulls authority)
 *   6. wallet_verification (confirm session is gone)
 *
 * Requires:
 *   - ALTANA_WALLET_DEFAULT_PRIVATE_KEY env var set to a funded BNB testnet wallet
 *     (the env path is the simplest fallback, no keychain needed)
 *
 * Run: bun run packages/mcp/scripts/smoke-mcp.ts
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { bscTestnet } from "viem/chains";

const ENTRY = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "mcp",
  "src",
  "index.ts",
);

// Funder for the freshly-generated admin wallet. Set via .env locally or
// GitHub Actions secret in CI. Never commit a real key.
const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY env var to a funded BNB testnet (tBNB) private key. " +
      "Locally: add to .env. CI: GitHub Actions secret.",
  );
}

const adminPk = generatePrivateKey();
const adminAccount = privateKeyToAccount(adminPk);

console.log("MCP smoke — Path B session flow on BNB testnet");
console.log("==========================================\n");
console.log("Admin wallet (env):", adminAccount.address);

// Fund admin from deployer (BNB testnet public RPC).
const deployer = privateKeyToAccount(TEST_FUNDER_KEY);
const deployerClient = createWalletClient({
  account: deployer,
  chain: bscTestnet,
  transport: http("https://bsc-testnet-rpc.publicnode.com"),
});
const fundTx = await deployerClient.sendTransaction({
  to: adminAccount.address,
  value: parseEther("0.006"),
});
console.log("[fund] tx:", fundTx);
// Don't wait for receipt; balance check below polls.
await new Promise((r) => setTimeout(r, 15_000));

// Boot the MCP server with the admin PK in env.
const proc = spawn("bun", ["run", ENTRY], {
  env: {
    ...process.env,
    ALTANA_WALLET_DEFAULT_PRIVATE_KEY: adminPk,
    ALTANA_CHAIN: "bnb-testnet",
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const responses = new Map<number, any>();
proc.stdout!.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch {
      /* ignore non-JSON */
    }
  }
});

let nextId = 1;
function send(method: string, params?: any): Promise<any> {
  const id = nextId++;
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (responses.has(id)) {
        const r = responses.get(id);
        responses.delete(id);
        if (r.error) return reject(new Error(JSON.stringify(r.error)));
        return resolve(r.result);
      }
      if (Date.now() - start > 300_000) return reject(new Error(`${method} timeout`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function call(name: string, args: any) {
  return send("tools/call", { name, arguments: args });
}

function txt(result: any) {
  if (result?.isError) {
    throw new Error(`Tool error: ${result.content?.[0]?.text ?? "unknown"}`);
  }
  return JSON.parse(result.content[0].text);
}

try {
  // 1. Initialize
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. wallet_balance
  console.log("\n[1] wallet_balance");
  const bal = txt(await call("wallet_balance", { name: "default" }));
  console.log("    address:", bal.address);
  console.log("    balance:", bal.balanceEth, "ETH");
  if (BigInt(bal.balanceWei) < parseEther("0.005")) {
    throw new Error("Admin wallet not funded — needs >= 0.005 ETH");
  }

  // 3. grant_session
  console.log("\n[2] grant_session");
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  console.log("    recipient (allow target):", recipient);
  const grant = txt(
    await call("grant_session", {
      walletName: "default",
      sessionName: "smoke-bot",
      recipient,
      dailyCapEth: "0.01",
      lifetimeSeconds: 3600,
    }),
  );
  console.log("    sessionAddress:", grant.sessionAddress);
  console.log("    keyId:         ", grant.keyId);
  console.log("    expiresAt:    ", grant.expiresAt);
  if (!grant.keyId) throw new Error("grant_session didn't return keyId");

  // 4. wallet_verification — both admin + session must be in KeyStore now
  console.log("\n[3] wallet_verification — expect 2 active keys");
  const ks = txt(await call("wallet_verification", { address: bal.address }));
  console.log("    active key count:", ks.activeKeyCount);
  if (ks.activeKeyCount !== 2) {
    throw new Error(
      `Expected 2 keys in KeyStore (admin + session), got ${ks.activeKeyCount}`,
    );
  }

  // 5. verify_authorization by sessionName — must return true
  console.log("\n[4] verify_authorization by sessionName — expect true");
  const verifyByName = txt(
    await call("verify_authorization", { sessionName: "smoke-bot" }),
  );
  console.log("    authorized:", verifyByName.authorized);
  if (verifyByName.authorized !== true) {
    throw new Error("Session not recognized in KeyStore after grant");
  }

  // 6. session_execute — agent path
  console.log("\n[5] session_execute (agent submits 1 wei to allowed recipient)");
  const exec = txt(
    await call("session_execute", {
      sessionName: "smoke-bot",
      to: recipient,
      valueEth: "0.000000000000000001", // 1 wei
    }),
  );
  console.log("    status:", exec.status);
  console.log("    tx:    ", exec.transactionHash);
  if (exec.status !== "CONFIRMED") {
    throw new Error(`Session execute failed: ${exec.status}`);
  }

  // 7. revoke_session
  console.log("\n[6] revoke_session");
  const rev = txt(await call("revoke_session", { sessionName: "smoke-bot" }));
  console.log("    status:", rev.status);
  console.log("    tx:    ", rev.transactionHash);

  // 8. verify_authorization with the original keyId — must now return false
  console.log("\n[7] verify_authorization by keyId after revoke — expect false");
  const verifyAfter = txt(
    await call("verify_authorization", {
      walletAddress: bal.address,
      keyId: grant.keyId,
    }),
  );
  console.log("    authorized:", verifyAfter.authorized);
  if (verifyAfter.authorized !== false) {
    throw new Error("Session still authorized in KeyStore after revoke");
  }

  console.log("\n==========================================");
  console.log("Result: PASS ✓");
} catch (err) {
  console.error("\nFAIL:", err);
  process.exit(1);
} finally {
  proc.kill();
}
