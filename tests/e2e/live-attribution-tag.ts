/**
 * Does an ERC-8021 attribution tag on the end of a call change anything on
 * our real path (SDK, relay, Orchestrator, account)?
 *
 * Every case runs twice, once plain and once tagged, and the two outcomes are
 * compared. Two modes:
 *
 *   sdk     the SDK adds the tag itself: the tagged run goes through a client
 *           created with `appCode`, the plain run through one created with
 *           `attribution: false`, and both are handed the same calls.
 *   manual  the script adds the tag to the call data and both runs go through
 *           a client with attribution off. This is the original proof, run
 *           before the SDK knew about tags (2026-11-23, 24 of 24).
 *
 * Signers: an admin key, a passkey (headless), and session keys granted by the
 * admin key. Cases per signer:
 *   - token transfer
 *   - token approve
 *   - a batch of two calls, tag on the last
 *   - a plain coin transfer, with the tag as its only data
 * Session-only cases:
 *   - a call the session allows (transfer), plain and tagged
 *   - a call the session does not allow (approve): must be refused both ways
 *   - a transfer over the session's spend limit: must be refused both ways
 *
 * Run (from tests/e2e, with the shared testnet env loaded):
 *   bun run live-attribution-tag.ts bnb          (sdk mode)
 *   bun run live-attribution-tag.ts celo
 *   bun run live-attribution-tag.ts bnb manual
 */
import {
  createClient,
  createHeadlessPasskey,
  quoteCalls,
  signerFromPrivateKey,
  waitForBalance,
  BNB_TESTNET,
  CELO_SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createClient as createViemClient,
  createPublicClient,
  createWalletClient,
  concat,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync, writeFileSync } from "node:fs";
import { attributionTag, parseAttribution } from "@altananetwork/sdk";
import { readRegistrationFee, registrationValueFor } from "../../packages/wallet/src/internal/keystore.js";
import { testnetEnvFile } from "./testnet-env.js";

const which = process.argv[2];
if (which !== "bnb" && which !== "celo") throw new Error("Say which network: bnb or celo.");

const mode = process.argv[3] ?? "sdk";
if (mode !== "sdk" && mode !== "manual") throw new Error("The mode is sdk or manual.");

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) throw new Error("Load the shared testnet env first (TEST_FUNDER_KEY).");

const network: NetworkConfig =
  which === "bnb"
    ? BNB_TESTNET
    : { ...CELO_SEPOLIA, ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}) };

/** A token the wallet can hold without a faucet: wrapped BNB, and CELO seen as a token. */
const TOKEN: Address = which === "bnb" ? "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" : "0x471EcE3750Da237f93B8E339c536989b8978a438";
const NEEDS_WRAP = which === "bnb";
const SYMBOL = network.chain.nativeCurrency.symbol;
/** Native coin sent to each wallet on top of its registration fees. The rest is returned. */
const HEADROOM = parseEther(process.env.ATTRIB_HEADROOM ?? (which === "bnb" ? "0.006" : "3"));

const CODES = ["altana", "altana_test"] as const;
const TAG = attributionTag(CODES);
const MARKER = "80218021802180218021802180218021";

const funder = privateKeyToAccount(TEST_FUNDER_KEY);
const publicClient = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });
const funderClient = createWalletClient({ account: funder, chain: network.chain, transport: http(network.publicRpcUrl) });
/** Sends the caller's bytes exactly. Also used for set-up and the sweep. */
const client = createClient({ chains: [network], attribution: false });
/** Adds the tag itself. */
const taggingClient = createClient({ chains: [network], appCode: CODES[1] });

type Call = { to: Address; value?: bigint; data?: Hex };
type Outcome = {
  ok: boolean;
  status?: string;
  transactionHash?: Hex;
  error?: string;
  gasUsed?: string;
  tokenEvents?: string[];
  eventCount?: number;
  tagOnChain?: boolean;
};
type CaseResult = { signer: string; name: string; expect: "succeeds" | "refused"; plain: Outcome; tagged: Outcome; pass: boolean; notes: string[] };
const results: CaseResult[] = [];

const tagged = (data: Hex | undefined): Hex => concat([data ?? "0x", TAG]);
const transfer = (amount: bigint): Call => ({ to: TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [funder.address, amount] }) });
const approve = (amount: bigint): Call => ({ to: TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [funder.address, amount] }) });

type Who = Parameters<typeof client.execute>[0] extends infer A ? Omit<A & object, "calls"> : never;

async function send(who: Who, calls: Call[], via: typeof client = client): Promise<Outcome> {
  try {
    const res = await via.execute({ ...(who as object), calls } as unknown as Parameters<typeof client.execute>[0]);
    if (res.status !== "CONFIRMED" || !res.transactionHash) {
      return { ok: false, status: res.status, ...(res.transactionHash ? { transactionHash: res.transactionHash } : {}), error: `status ${res.status}` };
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash: res.transactionHash });
    const tx = await publicClient.getTransaction({ hash: res.transactionHash });
    const tokenEvents = receipt.logs
      .filter((l) => l.address.toLowerCase() === TOKEN.toLowerCase())
      .map((l) => `${l.topics.join(",")}:${l.data}`);
    return {
      ok: receipt.status === "success",
      status: res.status,
      transactionHash: res.transactionHash,
      gasUsed: receipt.gasUsed.toString(),
      tokenEvents,
      eventCount: receipt.logs.length,
      tagOnChain: tx.input.toLowerCase().includes(TAG.slice(2).toLowerCase()),
    };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 220) };
  }
}

/** Runs one case plain and tagged, compares, records. `tagLast` puts the tag on the last call only. */
async function pair(signer: string, name: string, who: Who, calls: Call[], expect: "succeeds" | "refused" = "succeeds") {
  const withTag = calls.map((c, i) => (i === calls.length - 1 ? { ...c, data: tagged(c.data) } : c));
  console.log(`\n  ${signer}: ${name}`);
  const plain = await send(who, calls);
  console.log(`    plain : ${plain.ok ? `ok   ${plain.transactionHash} gas ${plain.gasUsed}` : `refused (${plain.error})`}`);
  const tag = mode === "sdk" ? await send(who, calls, taggingClient) : await send(who, withTag);
  console.log(`    tagged: ${tag.ok ? `ok   ${tag.transactionHash} gas ${tag.gasUsed}` : `refused (${tag.error})`}`);

  const notes: string[] = [];
  let pass = plain.ok === tag.ok;
  if (!pass) notes.push(`plain ${plain.ok ? "succeeded" : "was refused"} but tagged ${tag.ok ? "succeeded" : "was refused"}`);
  if ((expect === "succeeds") !== plain.ok) {
    pass = false;
    notes.push(`expected the plain call to be ${expect === "succeeds" ? "accepted" : "refused"}`);
  }
  if (plain.ok && tag.ok) {
    if (JSON.stringify(plain.tokenEvents) !== JSON.stringify(tag.tokenEvents)) {
      pass = false;
      notes.push("token events differ");
    }
    if (plain.eventCount !== tag.eventCount) {
      pass = false;
      notes.push(`event count differs (${plain.eventCount} vs ${tag.eventCount})`);
    }
    if (!tag.tagOnChain) {
      pass = false;
      notes.push("the tag is not in the mined transaction");
    }
    if (plain.tagOnChain) {
      pass = false;
      notes.push("the plain transaction carries a tag");
    }
    notes.push(`gas ${plain.gasUsed} plain, ${tag.gasUsed} tagged (${BigInt(tag.gasUsed!) - BigInt(plain.gasUsed!)} more)`);
  }
  console.log(`    ${pass ? "PASS" : "FAIL"}${notes.length ? `: ${notes.join("; ")}` : ""}`);
  results.push({ signer, name, expect, plain, tagged: tag, pass, notes });
}

async function fund(address: Address, amount: bigint) {
  const hash = await funderClient.sendTransaction({ to: address, value: amount });
  await publicClient.waitForTransactionReceipt({ hash });
  await waitForBalance(publicClient, address, amount, 120_000);
}

function saveSecret(name: string, value: string, note: string) {
  appendFileSync(testnetEnvFile(), `\n# live-attribution-tag ${note}, ${new Date().toISOString()}\n${name}='${value}'\n`);
}

/** What is left goes back to the funder, sized from the relay's own quote. Best effort. */
async function sweep(label: string, who: Who, address: Address, signer: unknown, submittingKey: unknown) {
  try {
    const balance = await publicClient.getBalance({ address });
    if (balance === 0n) return console.log(`  ${label}: nothing left`);
    const relay = createViemClient({ chain: network.chain, transport: http(network.relayUrl!) });
    const probe = await quoteCalls(relay as never, address, signer as never, [{ to: funder.address, value: 1n, data: "0x" }], {
      feeToken: "0x0000000000000000000000000000000000000000",
      submittingKey,
      network,
    } as never);
    const amount = balance - ((probe.nativeNeeded - 1n) * 13n) / 10n;
    if (amount <= 0n) return console.log(`  ${label}: ${formatEther(balance)} ${SYMBOL} left, below the transfer fee; kept`);
    const res = await client.execute({ ...(who as object), calls: { to: funder.address, value: amount, data: "0x" } } as unknown as Parameters<typeof client.execute>[0]);
    console.log(`  ${label}: returned ${formatEther(amount)} ${SYMBOL} (${res.status})`);
  } catch (err) {
    console.log(`  ${label}: sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

async function commonCases(signer: string, who: Who) {
  await pair(signer, "token transfer", who, [transfer(1_000n)]);
  await pair(signer, "token approve", who, [approve(1_000n)]);
  await pair(signer, "batch of two calls, tag on the last", who, [approve(2_000n), transfer(1_000n)]);
  await pair(signer, "plain coin transfer, tag as its only data", who, [{ to: funder.address, value: 1n, data: "0x" }]);
}

async function main() {
  console.log(`ERC-8021 tag on the real path: ${network.chain.name}, ${mode === "sdk" ? "the SDK adds the tag" : "the script adds the tag"}`);
  console.log(`tag ${TAG}  (${CODES.join(",")})`);
  const decoded = parseAttribution(concat(["0xdeadbeef", TAG]));
  if (JSON.stringify(decoded?.codes) !== JSON.stringify(CODES)) throw new Error("the tag does not decode back to its codes");
  if (!TAG.toLowerCase().endsWith(MARKER)) throw new Error("the tag does not end with the ERC-8021 marker");

  const fee = await readRegistrationFee(publicClient, network).catch(() => 0n);
  const perWallet = registrationValueFor(fee) + HEADROOM;
  const funderBalance = await publicClient.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} ${SYMBOL}; each of two wallets gets ${formatEther(perWallet)}`);
  if (funderBalance < perWallet * 2n + parseEther("0.001")) throw new Error(`The funder holds too little ${SYMBOL} for this run.`);

  // Admin-key wallet. Its key is saved before any funds move.
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const adminWallet = await client.createWallet({ signer: admin });
  saveSecret(`ATTRIB_${adminWallet.address.slice(2, 10).toUpperCase()}_KEY`, adminKey, `admin wallet ${adminWallet.address} on ${network.chain.name}`);
  const adminWho = { wallet: adminWallet, signer: admin } as unknown as Who;

  // Passkey wallet. Its credential is the only thing that can sign for it.
  const passkey = createHeadlessPasskey();
  const passkeyWallet = await client.createWallet({ signer: passkey });
  saveSecret(`ATTRIB_${passkeyWallet.address.slice(2, 10).toUpperCase()}_CREDENTIAL`, JSON.stringify(passkey.credential), `passkey wallet ${passkeyWallet.address} on ${network.chain.name}`);
  const passkeyWho = { wallet: passkeyWallet, signer: passkey } as unknown as Who;

  console.log(`admin wallet   ${adminWallet.address}`);
  console.log(`passkey wallet ${passkeyWallet.address}`);

  try {
    await fund(adminWallet.address, perWallet);
    await fund(passkeyWallet.address, perWallet);

    // First action of each wallet registers its key; kept out of the comparisons.
    for (const [label, who] of [["admin", adminWho], ["passkey", passkeyWho]] as const) {
      const warm: Call[] = NEEDS_WRAP
        ? [{ to: TOKEN, value: 1_000_000n, data: "0xd0e30db0" }]
        : [{ to: funder.address, value: 1n, data: "0x" }];
      const res = await send(who, warm);
      console.log(`first action (${label}): ${res.ok ? `ok ${res.transactionHash}` : `FAILED ${res.error}`}`);
      if (!res.ok) throw new Error(`the ${label} wallet's first action failed: ${res.error}`);
    }

    await commonCases("admin key", adminWho);
    await commonCases("passkey", passkeyWho);

    // Session: may only call transfer on the token, up to 5,000 units a day.
    const session = await client.grantSession({
      wallet: adminWallet,
      signer: admin,
      register: false,
      permissions: {
        calls: [{ to: TOKEN, signature: "transfer(address,uint256)" }],
        spend: [
          { limit: 5_000n, period: "day", token: TOKEN },
          { limit: parseEther(which === "bnb" ? "0.01" : "5"), period: "day" },
        ],
      },
      expiry: Math.floor(Date.now() / 1000) + 3600,
    } as Parameters<typeof client.grantSession>[0]);
    if (session.status !== "granted") throw new Error(`grantSession: ${session.status}`);
    console.log(`\nsession granted: transfer on the token only, 5000 units a day`);
    const sessionWho = { session } as unknown as Who;

    await pair("session key", "allowed call (transfer)", sessionWho, [transfer(1_000n)]);
    await pair("session key", "call the session does not allow (approve)", sessionWho, [approve(1_000n)], "refused");
    await pair("session key", "transfer over the spend limit", sessionWho, [transfer(50_000n)], "refused");
    await pair("session key", "allowed call again, still inside the limit", sessionWho, [transfer(1_000n)]);
  } finally {
    const file = `attribution-tag-run-${which}${mode === "sdk" ? "-sdk" : ""}-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(
      new URL(file, import.meta.url),
      JSON.stringify({ mode, network: network.chain.name, chainId: network.chainId, tag: TAG, codes: CODES, token: TOKEN, adminWallet: adminWallet.address, passkeyWallet: passkeyWallet.address, explorer: network.explorer, results }, null, 2) + "\n",
    );
    console.log(`\nresults saved to tests/e2e/${file}`);
    console.log("\nreturning leftover funds to the funder");
    await sweep("admin wallet", adminWho, adminWallet.address, admin, { type: "secp256k1", publicKey: admin.publicKey, role: "admin" });
    await sweep("passkey wallet", passkeyWho, passkeyWallet.address, passkey, { type: "webauthn-p256", signer: passkey, role: "admin" });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} of ${results.length} cases passed`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.signer}: ${r.name}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nattribution tag run crashed:", err);
  process.exit(1);
});
