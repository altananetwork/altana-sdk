/**
 * The MCP server's transactions carry its attribution tag.
 *
 * Starts the server over stdio on Celo Sepolia with `ALTANA_APP_CODE=my_agent`,
 * sends one token approval with `wallet_execute`, and reads the mined
 * transaction back: it must carry `altana,altana_mcp,my_agent`.
 *
 * Needs, with the shared testnet env loaded:
 *   ATTRIB_MCP_WALLET_KEY  the key of an Altana wallet on Celo Sepolia that has
 *                          made its first action (one from live-attribution-tag)
 *   TEST_FUNDER_KEY        tops the wallet up with CELO for the fee
 *
 * Run: bun run live-attribution-mcp.ts
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { CELO_SEPOLIA, parseAttribution, waitForBalance } from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const walletKey = process.env.ATTRIB_MCP_WALLET_KEY as Hex;
const funderKey = process.env.TEST_FUNDER_KEY as Hex;
if (!walletKey || !funderKey) throw new Error("Set ATTRIB_MCP_WALLET_KEY and load the shared testnet env (TEST_FUNDER_KEY).");

const rpc = process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA.publicRpcUrl;
const publicClient = createPublicClient({ chain: CELO_SEPOLIA.chain, transport: http(rpc) });
const funder = privateKeyToAccount(funderKey);
const wallet = privateKeyToAccount(walletKey).address;
const CELO_TOKEN = "0x471EcE3750Da237f93B8E339c536989b8978a438";
const EXPECTED = ["altana", "altana_mcp", "my_agent"];

const want = parseEther(process.env.ATTRIB_MCP_BALANCE ?? "1.5");
const have = await publicClient.getBalance({ address: wallet });
if (have < want) {
  const hash = await createWalletClient({ account: funder, chain: CELO_SEPOLIA.chain, transport: http(rpc) }).sendTransaction({ to: wallet, value: want - have });
  await publicClient.waitForTransactionReceipt({ hash });
  await waitForBalance(publicClient, wallet, want, 120_000);
}
console.log(`wallet ${wallet} funded`);

const proc = spawn("bun", ["run", join(import.meta.dir, "..", "..", "packages", "mcp", "src", "index.ts")], {
  env: { ...process.env, ALTANA_WALLET_DEFAULT_PRIVATE_KEY: walletKey, ALTANA_CHAIN: "celo-sepolia", ALTANA_APP_CODE: "my_agent", ALTANA_AGENT_IDENTITY: "off" },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
const responses = new Map<number, any>();
proc.stdout!.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch {
      /* not a JSON line */
    }
  }
});
let nextId = 1;
function send(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const r = responses.get(id);
      if (r) return r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.result);
      if (Date.now() - start > 300_000) return reject(new Error(`${method} timed out`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

let pass = false;
try {
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "attribution", version: "0" } });
  const result = await send("tools/call", {
    name: "wallet_execute",
    arguments: { name: "default", to: CELO_TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [funder.address, 1_000n] }) },
  });
  const text = String(result?.content?.[0]?.text ?? "");
  if (result?.isError) throw new Error(`wallet_execute: ${text}`);
  // The answer also carries the bundle id, which looks like a hash: take the field by name.
  const hash = (JSON.parse(text) as { transactionHash?: Hex }).transactionHash;
  if (!hash) throw new Error(`wallet_execute returned no transaction hash: ${text.slice(0, 300)}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const tx = await publicClient.getTransaction({ hash });
  const codes = parseAttribution(tx.input)?.codes;
  pass = receipt.status === "success" && JSON.stringify(codes) === JSON.stringify(EXPECTED);
  console.log(`transaction ${hash}: ${receipt.status}`);
  console.log(`codes on chain: ${codes?.join(",") ?? "none"}`);
} finally {
  proc.kill();
}
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
