/**
 * Does an agent acting the instant it is granted get refused?
 *
 * QA saw ExceededSpendLimit on an amount a tenth of the limit, with nothing
 * spent, and found the cause: the account did not yet answer for the new key's
 * spend cap, so the relay simulated against an allowance of zero and refused
 * every amount. This measures that directly rather than taking it on reasoning.
 *
 * It grants, executes immediately, and records what happened; then polls for the
 * cap and executes again.
 *
 * **Measured twice live on 2026-10-06 and the race did not reproduce.** In both
 * runs the cap was readable the moment `grantSession` returned. One of the two
 * immediate spends was refused anyway, with a generic FAILED rather than
 * ExceededSpendLimit, which is the shape of the relay's measured offchain
 * failure rate and not a cap problem. So the refusal QA saw is not explained by
 * this, and the wait that was added to the app is cheap insurance rather than a
 * demonstrated cure.
 *
 *   set -a; source .env.testnet; set +a
 *   bun run tests/e2e/cap-race.ts            # live chain 97
 */

import { logRelayIdentity } from "./relay-identity.js";
import {
  createClient, createHeadlessPasskey, keyHashForSessionOrKey,
  signerFromPrivateKey, BNB_TESTNET, type NetworkConfig,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { createWalletClient, formatEther, http, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = process.env.AGENT_RPC_URL || BNB_TESTNET.publicRpcUrl;
const RELAY_URL = process.env.AGENT_RELAY_URL || BNB_TESTNET.relayUrl!;
const IS_FORK = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");
const NETWORK: NetworkConfig = { ...BNB_TESTNET, publicRpcUrl: RPC_URL, relayUrl: RELAY_URL };
const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
const LIMIT = parseEther("0.001");
const SPEND = parseEther("0.0001"); // a tenth of the limit, QA's amount

const ABI = [{
  type: "function", name: "spendInfos", stateMutability: "view",
  inputs: [{ name: "keyHash", type: "bytes32" }],
  outputs: [{ name: "r", type: "tuple[]", components: [
    { name: "token", type: "address" }, { name: "period", type: "uint8" },
    { name: "limit", type: "uint256" }, { name: "spent", type: "uint256" },
    { name: "lastUpdated", type: "uint256" }, { name: "currentSpent", type: "uint256" },
    { name: "current", type: "uint256" }]}],
}] as const;

const client = createClient({ chains: [NETWORK] });
const pub = buildPublicClient(NETWORK);
const funder = privateKeyToAccount(process.env.TEST_FUNDER_KEY as Hex);
const passkey = createHeadlessPasskey();

/** Return whatever is left, from the end of the run or from a failure. */
async function sweep() {
  const left = await pub.getBalance({ address: wallet.address }).catch(() => 0n);
  const margin = parseEther("0.004");
  if (left <= margin) {
    console.log(`\n  only ${formatEther(left)} tBNB left, below the fee margin`);
    return;
  }
  await client
    .execute({ wallet, signer: passkey, calls: { to: funder.address, value: left - margin, data: "0x" } })
    .then(() => console.log(`\n  swept ${formatEther(left - margin)} tBNB back`))
    .catch((e: Error) => console.log(`\n  sweep failed: ${e.message.slice(0, 90)}`));
}

console.log(`the spend-cap race, ${IS_FORK ? "anvil fork" : "LIVE chain 97"}`);
await logRelayIdentity(RELAY_URL);

const wallet = await client.createWallet({ signer: passkey });

/* The credential, printed before a single tBNB goes anywhere.
   
   A headless passkey lives only in this process. The first version of this file
   funded the wallet and then threw on a failed grant, which stranded 0.05 tBNB
   with no way to authorise a sweep, because the only key that could had died
   with the process. Printing it first makes any crash recoverable:
   
     SWEEP_CREDENTIAL='<the line below>' bun run sweep -- <wallet> */
console.log(`  credential ${JSON.stringify((passkey as any).credential)}`);

const tx = await createWalletClient({ account: funder, chain: bscTestnet, transport: http(RPC_URL) })
  .sendTransaction({ to: wallet.address, value: parseEther("0.05") });
for (let i = 0; i < 90; i++) {
  if (await pub.getTransactionReceipt({ hash: tx }).catch(() => undefined)) break;
  const t = await pub.getTransaction({ hash: tx }).catch(() => undefined);
  if (t?.blockNumber != null) break;
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`  wallet ${wallet.address}`);

/* Retried once, visibly. About one in five first bundles fails offchain on the
   hosted relay for reasons unrelated to this, and a run that dies on that blip
   costs a funded wallet rather than a measurement. */
const grant = () =>
  client.grantSession({
    wallet, signer: passkey, sessionSigner: signerFromPrivateKey(generatePrivateKey()),
    permissions: { calls: [{ to: DEAD }], spend: [{ limit: LIMIT, period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });

let session = await grant();
if (session.status !== "granted") {
  console.log(`  grant ${session.status}, retrying once`);
  session = await grant();
}
if (session.status !== "granted") {
  await sweep();
  throw new Error(`grant failed twice: ${session.status}`);
}
const keyHash = keyHashForSessionOrKey(session);
const grantedAt = Date.now();
console.log(`  granted, limit ${formatEther(LIMIT)} tBNB/day, spending ${formatEther(SPEND)}\n`);

const capReadable = async () => {
  const r: any = await pub
    .readContract({ address: wallet.address, abi: ABI, functionName: "spendInfos", args: [keyHash] })
    .catch(() => []);
  return r.length > 0;
};

const spend = async (label: string) => {
  const at = ((Date.now() - grantedAt) / 1000).toFixed(1);
  const result = await client
    .execute({ wallet, session, calls: { to: DEAD, value: SPEND, data: "0x" } })
    .then((r) => ({ ok: String(r.status).toUpperCase() === "CONFIRMED", detail: String(r.status) }))
    .catch((e: Error) => ({ ok: false, detail: e.message.slice(0, 90) }));
  console.log(`  ${label.padEnd(26)} +${at}s  ${result.ok ? "LANDED" : "REFUSED"}  ${result.detail}`);
  return result.ok;
};

const capAtFirstTry = await capReadable();
console.log(`  cap readable at once?       ${capAtFirstTry}`);
const immediate = await spend("immediately after grant");

let waited = 0;
while (!(await capReadable()) && waited < 60) {
  await new Promise((r) => setTimeout(r, 1000));
  waited += 1;
}
console.log(`  cap became readable after   ${waited}s`);
const afterWait = await spend("after the cap is readable");

/* The verdict has to say which thing it saw, and the first version of it did
   not. It printed "the race is real" for any refused-then-landed pair, without
   checking whether the cap had been readable at the time of the refusal. On the
   second live run the cap *was* readable and the spend was refused anyway, which
   is not a cap race at all, and the verdict said it was. A conclusion that
   cannot tell two causes apart is the bug this whole evening was about. */
console.log("\n  verdict");
if (immediate && afterWait) {
  console.log("    no refusal to explain: both spends landed");
} else if (!immediate && !capAtFirstTry && afterWait) {
  console.log("    a cap race: the cap was not readable, the spend was refused, it lands once it is");
} else if (!immediate && capAtFirstTry && afterWait) {
  console.log("    NOT a cap race: the cap was already readable and the spend was still refused.");
  console.log("    Look at the relay's offchain failure rate, not at cap visibility.");
} else {
  console.log("    neither pattern fits; read the statuses above rather than this line");
}

await sweep();
