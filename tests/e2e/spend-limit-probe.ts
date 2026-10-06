/**
 * What a 0.001 tBNB a day limit can actually be spent against.
 *
 * QA's walkthrough agent was refused ExceededSpendLimit on 0.0001 against a
 * 0.001 limit with nothing spent, while the snippet test spends 0.0000001
 * against the same limit and lands. Both cannot be ordinary, so this walks the
 * amount up on one wallet and prints what the account says after each attempt.
 *
 * ## What it measured, 2026-10-06
 *
 * **The relay fee is charged against the session key's own spend allowance.**
 * Spending 0.0000001 tBNB moved `currentSpent` by 0.0000283116, which is the
 * transfer plus the fee, not the transfer. So a limit is a budget for what the
 * agent moves **and** what its bundles cost.
 *
 * Live chain 97, 0.001 tBNB a day:
 *
 *     0.0000001  CONFIRMED  currentSpent +0.0000283116
 *     0.00001    CONFIRMED               +0.0000365439
 *     0.0001     CONFIRMED               +0.0001265439
 *     0.0005     CONFIRMED               +0.0005265439
 *
 * The live fee is about 0.0000265 tBNB a bundle, so a 0.001 a day limit carries
 * roughly thirty-odd agent transactions before fees alone exhaust it. That is
 * comfortable, and it means the fee does **not** explain QA's refusal: 0.0001
 * plus a fee of 0.0000265 is nowhere near 0.001, and it lands here.
 *
 * **Do not read fork numbers as live ones.** The same walk on the anvil fork
 * charged 0.000383804 for the first bundle and exhausted the same limit after
 * two transactions. The mechanism is identical; the gas pricing is not.
 */
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
const NETWORK: NetworkConfig = { ...BNB_TESTNET, publicRpcUrl: RPC_URL, relayUrl: RELAY_URL };
const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
const LIMIT = parseEther("0.001");

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
const funder = privateKeyToAccount(FUNDER_KEY);
const passkey = createHeadlessPasskey();
const wallet = await client.createWallet({ signer: passkey });
console.log(`mode   ${RPC_URL.includes("127.0.0.1") ? "fork" : "LIVE"}`);
console.log(`wallet ${wallet.address}`);

const tx = await createWalletClient({ account: funder, chain: bscTestnet, transport: http(RPC_URL) })
  .sendTransaction({ to: wallet.address, value: parseEther("0.05") });
for (let i = 0; i < 90; i++) {
  if (await pub.getTransactionReceipt({ hash: tx }).catch(() => undefined)) break;
  const t = await pub.getTransaction({ hash: tx }).catch(() => undefined);
  if (t?.blockNumber != null) break;
  await new Promise((r) => setTimeout(r, 2000));
}

const secret = generatePrivateKey();
const session = await client.grantSession({
  wallet, signer: passkey, sessionSigner: signerFromPrivateKey(secret),
  permissions: { calls: [{ to: DEAD }], spend: [{ limit: LIMIT, period: "day" }] },
  expiry: Math.floor(Date.now() / 1000) + 3600,
});
if (session.status !== "granted") throw new Error(`grant failed: ${session.status}`);
const keyHash = keyHashForSessionOrKey(session);
console.log(`grant  limit ${formatEther(LIMIT)} tBNB/day  keyHash ${keyHash}\n`);

async function cap() {
  const r: any = await pub.readContract({ address: wallet.address, abi: ABI, functionName: "spendInfos", args: [keyHash] });
  const n = r[0];
  return n ? { limit: n.limit as bigint, currentSpent: n.currentSpent as bigint } : undefined;
}

for (const amount of ["0.0000001", "0.00001", "0.0001", "0.0005"]) {
  const before = await cap();
  const res = await client.execute({ wallet, session, calls: { to: DEAD, value: parseEther(amount), data: "0x" } })
    .then((r) => ({ ok: true, detail: String(r.status) }))
    .catch((e: Error) => ({ ok: false, detail: e.message.slice(0, 110) }));
  const after = await cap();
  const moved = after && before ? after.currentSpent - before.currentSpent : 0n;
  const verdict = res.ok ? `status ${res.detail}`.padEnd(18) : "REFUSED".padEnd(18);
  console.log(`${amount.padEnd(10)} ${verdict} currentSpent ${formatEther(after?.currentSpent ?? 0n)}  (+${formatEther(moved)})`);
  if (!res.ok) console.log(`           ${res.detail}`);
}

const left = await pub.getBalance({ address: wallet.address });
if (left > parseEther("0.004")) {
  await client.execute({ wallet, signer: passkey, calls: { to: funder.address, value: left - parseEther("0.004"), data: "0x" } })
    .then(() => console.log(`\nswept ${formatEther(left - parseEther("0.004"))} back to the funder`))
    .catch((e: Error) => console.log(`\nsweep failed: ${e.message.slice(0, 90)}`));
}
