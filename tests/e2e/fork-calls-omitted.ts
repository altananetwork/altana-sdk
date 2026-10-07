/**
 * A session granted with no `calls` must be able to act.
 *
 * The regression test for a trap that reached a live wallet: the type promised
 * that omitting `calls` allowed every target, and it authorized none, so a
 * session granted that way was refused with `UnauthorizedCall` the first time
 * its agent acted. The grant itself succeeded and reported "granted", so nothing
 * connected the failure back to its cause.
 *
 * It is a fork test rather than a unit test because only the account contract
 * can answer the question. A unit test can check what the SDK sends; only the
 * chain can say whether the account accepts it.
 *
 * The control matters as much as the case: a session scoped to one target must
 * still be refused elsewhere, or a fix that simply allowed everything would
 * pass and would have given every agent the whole wallet.
 *
 *   scripts/fork/start.sh --with-relay
 *   set -a; source .fork/fork.env.out; set +a
 *   AGENT_RPC_URL=$FORK_RPC_URL AGENT_RELAY_URL=$ALTANA_RELAY_URL bun run fork:calls-omitted
 */

import {
  createClient,
  createHeadlessPasskey,
  signerFromPrivateKey,
  BNB_TESTNET,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = process.env.AGENT_RPC_URL;
const RELAY_URL = process.env.AGENT_RELAY_URL;
if (!RPC_URL || !RELAY_URL) {
  throw new Error(
    "Set AGENT_RPC_URL and AGENT_RELAY_URL to a fork and a relay running against it. " +
      "This test grants unscoped sessions, so it must not run against live chain 97.",
  );
}
if (!RPC_URL.includes("127.0.0.1") && !RPC_URL.includes("localhost")) {
  throw new Error("This test only runs against a local fork. It grants a session with no scope.");
}

const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex | undefined;
if (!FUNDER_KEY) throw new Error("TEST_FUNDER_KEY is not set. Load the shared .env.testnet.");

const NETWORK: NetworkConfig = { ...BNB_TESTNET, publicRpcUrl: RPC_URL, relayUrl: RELAY_URL };
const TARGET_A = "0x000000000000000000000000000000000000dEaD" as const;
const TARGET_B = "0x000000000000000000000000000000000000bEEF" as const;

const results: { id: string; what: string; pass: boolean; detail: string }[] = [];
const record = (id: string, what: string, pass: boolean, detail = "") => {
  results.push({ id, what, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id.padEnd(3)} ${what}${detail ? `  ${detail}` : ""}`);
};

const client = createClient({ chains: [NETWORK] });
const publicClient = buildPublicClient(NETWORK);

const passkey = createHeadlessPasskey();
const wallet = await client.createWallet({ signer: passkey });
const funder = privateKeyToAccount(FUNDER_KEY);
await publicClient.waitForTransactionReceipt({
  hash: await createWalletClient({
    account: funder,
    chain: bscTestnet,
    transport: http(RPC_URL),
  }).sendTransaction({ to: wallet.address, value: parseEther("0.1") }),
});

console.log("A session granted with no allowed contracts must still be able to act");
console.log(`  wallet  ${wallet.address}\n`);

async function grant(permissions: Parameters<typeof client.grantSession>[0]["permissions"]) {
  const session = await client.grantSession({
    wallet,
    signer: passkey,
    sessionSigner: signerFromPrivateKey(generatePrivateKey()),
    permissions,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  if (session.status !== "granted") throw new Error(`grant failed: ${session.status}`);
  return session;
}

/** Did the session manage to send to this target? A refusal is a result. */
async function canSendTo(session: Awaited<ReturnType<typeof grant>>, to: Address) {
  try {
    const r = await client.execute({ session, calls: { to, value: 1n, data: "0x" } });
    return { allowed: String(r.status).toUpperCase() === "CONFIRMED", why: String(r.status) };
  } catch (err) {
    const message = String((err as Error).message);
    return {
      allowed: false,
      why: /UnauthorizedCall/.test(message) ? "UnauthorizedCall" : message.slice(0, 100),
    };
  }
}

const SPEND = [{ limit: parseEther("0.001"), period: "day" as const }];

// The case: no calls at all, which is what the app sends when the person leaves
// "allowed contracts" blank.
const unscoped = await grant({ spend: SPEND });
const unscopedA = await canSendTo(unscoped, TARGET_A);
const unscopedB = await canSendTo(unscoped, TARGET_B);
record("C1", "a session with no allowed contracts can act", unscopedA.allowed, unscopedA.why);
record("C2", "and is not limited to one target by accident", unscopedB.allowed, unscopedB.why);

// The control: an explicit target must still be a restriction, or a fix that
// allowed everything would pass this file while handing agents the whole wallet.
const scoped = await grant({ calls: [{ to: TARGET_A }], spend: SPEND });
const scopedA = await canSendTo(scoped, TARGET_A);
const scopedB = await canSendTo(scoped, TARGET_B);
record("C3", "a scoped session can act on its allowed target", scopedA.allowed, scopedA.why);
record("C4", "a scoped session is refused on any other target", !scopedB.allowed, scopedB.why);

console.log("\n==========================================");
for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id} ${r.what}`);
const failed = results.filter((r) => !r.pass);
console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
