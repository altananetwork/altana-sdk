/**
 * The altana-wallet app's spine, end to end, on BNB Chain testnet.
 *
 *   create a passkey wallet -> fund it -> grant a session -> the session
 *   executes -> read the movement back and attribute it -> revoke -> the
 *   session is rejected
 *
 * Runs against either an anvil fork or live chain 97, chosen entirely by env,
 * so the same script produces both the fork proof and the live proof:
 *
 *   # fork, with a local relay
 *   wallet-harness/worktrees/backend/scripts/fork/start.sh --with-relay
 *   set -a; source .fork/fork.env.out; set +a
 *   SPINE_RPC_URL=$FORK_RPC_URL SPINE_RELAY_URL=$ALTANA_RELAY_URL bun run tests/e2e/wallet-app-spine.ts
 *
 *   # live
 *   bun run tests/e2e/wallet-app-spine.ts
 *
 * Needs TEST_FUNDER_KEY from the shared .env.testnet. The key is never printed.
 */

import {
  createClient,
  createHeadlessPasskey,
  signerFromPrivateKey,
  getKeys,
  serializeSession,
  deserializeSession,
  keyHashForSessionOrKey,
  BNB_TESTNET,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import {
  createWalletClient,
  http,
  parseEther,
  formatEther,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const RPC_URL = process.env.SPINE_RPC_URL || BNB_TESTNET.publicRpcUrl;
const RELAY_URL = process.env.SPINE_RELAY_URL || BNB_TESTNET.relayUrl!;
const IS_FORK = RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost");

const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex | undefined;
if (!FUNDER_KEY) throw new Error("TEST_FUNDER_KEY is not set. Load the shared .env.testnet.");

// The chain under test: BNB testnet, pointed at whichever RPC and relay the
// caller chose. Nothing else about the config changes between fork and live.
const NETWORK: NetworkConfig = {
  ...BNB_TESTNET,
  publicRpcUrl: RPC_URL,
  relayUrl: RELAY_URL,
};

const RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;

const t0 = performance.now();
const el = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
const say = (s: string) => console.log(s);
const step = (n: string) => console.log(`\n[${n}]  (+${el()})`);
const ok = (s: string) => console.log(`  ok    ${s}`);
const info = (k: string, v: unknown) => console.log(`  ${k.padEnd(14)}${v}`);

// The relay's terminal success status is CONFIRMED. Treat nothing else as landed.
const landed = (status: unknown) => String(status).toUpperCase() === "CONFIRMED";

const results: { id: string; what: string; pass: boolean; detail: string }[] = [];
const record = (id: string, what: string, pass: boolean, detail = "") => {
  results.push({ id, what, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id}  ${what}${detail ? `  ${detail}` : ""}`);
};

async function main() {
  say("altana-wallet spine on BNB Chain testnet (chain 97)");
  say("===================================================");
  info("mode", IS_FORK ? "anvil fork" : "LIVE chain 97");
  info("rpc", RPC_URL);
  info("relay", RELAY_URL);

  const publicClient = buildPublicClient(NETWORK);
  const chainId = await publicClient.getChainId();
  info("chain id", chainId);
  if (chainId !== 97) throw new Error(`expected chain 97, got ${chainId}`);
  info("block", await publicClient.getBlockNumber());

  const client = createClient({ chains: [NETWORK] });

  const funder = privateKeyToAccount(FUNDER_KEY);
  const funderClient = createWalletClient({
    account: funder,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });
  const funderBalance = await publicClient.getBalance({ address: funder.address });
  info("funder", `${funder.address}  ${formatEther(funderBalance)} tBNB`);
  if (funderBalance === 0n) throw new Error("the funder holds no tBNB on this chain");

  // E1 ---------------------------------------------------------------------
  step("E1  create the wallet with a headless passkey");
  const passkey = createHeadlessPasskey();
  info("passkey", `${passkey.type}  ${passkey.credential.kind}`);
  const wallet = await client.createWallet({ signer: passkey });
  info("address", wallet.address);
  // createWallet is counterfactual: the address is derived and the passkey is
  // authorized locally, but nothing is broadcast until the first bundle. So the
  // address being well formed is what E1 can assert here; the delegation code
  // is checked after the grant, below, as E1b.
  const codeAtCreate = await publicClient.getCode({ address: wallet.address });
  record("E1", "wallet created, address derived",
    /^0x[0-9a-fA-F]{40}$/.test(wallet.address),
    `${wallet.address}, delegation code now: ${codeAtCreate && codeAtCreate !== "0x" ? "yes" : "not yet (counterfactual)"}`);

  // E2 ---------------------------------------------------------------------
  step("E2  fund the wallet from the shared funder");
  const fundAmount = parseEther("0.02");
  const fundTx = await funderClient.sendTransaction({ to: wallet.address, value: fundAmount });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  const walletBalance = await publicClient.getBalance({ address: wallet.address });
  info("fund tx", fundTx);
  info("balance", `${formatEther(walletBalance)} tBNB`);
  record("E2", "wallet funded", walletBalance >= fundAmount, `${formatEther(walletBalance)} tBNB`);

  // The SDK's own balances read, which the app's lib/altana wraps.
  const balances = await client.balances({ wallet });
  info("sdk balances", JSON.stringify(balances, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 200));

  // E3 ---------------------------------------------------------------------
  step("E3  grant a session with a spend limit, a period and an expiry");
  const sessionPk = generatePrivateKey();
  const sessionSigner = signerFromPrivateKey(sessionPk);
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const session = await client.grantSession({
    wallet,
    signer: passkey,
    sessionSigner,
    permissions: {
      calls: [{ to: RECIPIENT }],
      spend: [{ limit: parseEther("0.001"), period: "day" }],
    },
    expiry,
  });
  info("status", session.status);
  if (session.status !== "granted") {
    say(`  legs: ${JSON.stringify(session.legs, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  const keyHash = keyHashForSessionOrKey(session);
  info("keyHash", keyHash);
  const activeKeys = await getKeys(publicClient, wallet.address);
  info("key hashes", JSON.stringify(activeKeys.keyHashes));
  record("E3", "session granted and registered on the account",
    session.status === "granted" &&
      activeKeys.keyHashes.some((h) => h.toLowerCase() === keyHash.toLowerCase()),
    `keyHash ${keyHash.slice(0, 18)}, ${activeKeys.keyHashes.length} keys on the account`);

  // Now that a bundle has landed, the 7702 delegation must be in place.
  const codeAfterGrant = await publicClient.getCode({ address: wallet.address });
  record("E1b", "the wallet is delegated once its first bundle lands",
    !!codeAfterGrant && codeAfterGrant !== "0x",
    `code ${codeAfterGrant ? codeAfterGrant.length : 0} chars`);

  // Session serialization, which is how the app persists a permission and how
  // the agent receives it. Note the split: serializeSession stores everything
  // EXCEPT the secret, and deserializeSession needs the stored half plus the
  // signer the holder kept. So the app can keep the stored half in
  // localStorage safely, and the private key is the one thing shown once.
  const stored = serializeSession(session);
  const storedJson = JSON.stringify(stored);
  const hasSecret = /0x[0-9a-fA-F]{64}/.test(storedJson.replace(session.publicKey, ""));
  record("E3b", "the serialized session carries no private key",
    !storedJson.includes(sessionPk.slice(2)) && !hasSecret,
    `${storedJson.length} chars, keys: ${Object.keys(stored).join(", ")}`);

  const round = deserializeSession(stored, sessionSigner);
  record("E3c", "session round-trips to the same on-chain key hash",
    keyHashForSessionOrKey(round).toLowerCase() === keyHash.toLowerCase(),
    keyHashForSessionOrKey(round).slice(0, 18));

  // E4 ---------------------------------------------------------------------
  step("E4  the agent acts with the session key, within the limit");
  const exec = await client.execute({
    session,
    calls: { to: RECIPIENT, value: 1n, data: "0x" },
  });
  info("status", exec.status);
  info("tx", exec.transactionHash);
  record("E4", "session executed inside its limit",
    landed(exec.status) && !!exec.transactionHash, `${exec.status} ${exec.transactionHash}`);

  // E5 ---------------------------------------------------------------------
  step("E5  the movement comes back from the relay, attributed to the agent");
  const history = await relayCall(RELAY_URL, "wallet_getCallsHistory", [
    { address: wallet.address, limit: 20, sort: "desc" },
  ]);
  info("entries", Array.isArray(history) ? history.length : JSON.stringify(history).slice(0, 120));
  const entries = Array.isArray(history) ? history : [];
  for (const e of entries) {
    const tag = e.keyHash === "0x" + "0".repeat(64) ? "owner" :
      e.keyHash?.toLowerCase() === keyHash.toLowerCase() ? "OUR SESSION" : "other key";
    info(`  #${e.index}`, `${e.transactions?.[0]?.transactionHash?.slice(0, 20)}  keyHash ${e.keyHash?.slice(0, 14)}  ${tag}`);
  }
  const mine = entries.find(
    (e: any) => e.keyHash?.toLowerCase() === keyHash.toLowerCase(),
  );
  record("E5", "the agent's transaction is attributable by keyHash",
    !!mine, mine ? `bundle ${mine.id?.slice(0, 18)} index ${mine.index}` : "no entry carried our keyHash");

  // E6 ---------------------------------------------------------------------
  step("E6  a spend over the limit is rejected");
  let overLimitRejected = false;
  let overLimitWhy = "";
  try {
    const over = await client.execute({
      session,
      calls: { to: RECIPIENT, value: parseEther("0.01"), data: "0x" },
    });
    overLimitRejected = !landed(over.status);
    overLimitWhy = `status ${over.status}`;
  } catch (err) {
    overLimitRejected = true;
    overLimitWhy = String((err as Error).message).slice(0, 140);
  }
  record("E6", "a spend above the limit is refused", overLimitRejected, overLimitWhy);

  const stillThere = await publicClient.getBalance({ address: wallet.address });
  record("E6b", "the wallet is otherwise unharmed", stillThere > 0n, `${formatEther(stillThere)} tBNB`);

  // E9 ---------------------------------------------------------------------
  step("E9  revoke the session");
  const revoke = await client.revokeSession({ wallet, signer: passkey, session });
  info("status", revoke.status);
  for (const leg of revoke.legs ?? []) {
    info("  leg", `${leg.chainId} ${leg.kind} ${leg.status} ${leg.transactionHash ?? leg.reason ?? ""}`);
  }
  const keysAfter = await getKeys(publicClient, wallet.address);
  const gone = !keysAfter.keyHashes.some((h) => h.toLowerCase() === keyHash.toLowerCase());
  record("E9", "session revoked", revoke.status === "revoked", `status ${revoke.status}`);
  record("E10a", "the key is gone from the account", gone, JSON.stringify(keysAfter.keyHashes));

  // E10 --------------------------------------------------------------------
  step("E10  the agent is rejected after revoke");
  let afterRevokeRejected = false;
  let afterRevokeWhy = "";
  try {
    const after = await client.execute({
      session,
      calls: { to: RECIPIENT, value: 1n, data: "0x" },
    });
    afterRevokeRejected = !landed(after.status);
    afterRevokeWhy = `status ${after.status} ${after.transactionHash ?? ""}`;
  } catch (err) {
    afterRevokeRejected = true;
    afterRevokeWhy = String((err as Error).message).slice(0, 140);
  }
  record("E10", "the revoked session is refused", afterRevokeRejected, afterRevokeWhy);

  // Sweep ------------------------------------------------------------------
  // The wallet is a throwaway owned by a headless passkey that only exists in
  // this process, so anything left here is stranded the moment the script ends.
  // Send it back to the funder while we still hold the key.
  step("sweep  return the leftover tBNB to the funder");
  const leftover = await publicClient.getBalance({ address: wallet.address });
  info("leftover", `${formatEther(leftover)} tBNB`);
  // The relay takes its fee from this same balance, so leave it room.
  const feeMargin = parseEther("0.004");
  if (leftover > feeMargin) {
    const sweepAmount = leftover - feeMargin;
    try {
      const sweep = await client.execute({
        wallet,
        signer: passkey,
        calls: { to: funder.address, value: sweepAmount, data: "0x" },
      });
      const after = await publicClient.getBalance({ address: wallet.address });
      record("sweep", "leftover tBNB returned to the funder",
        landed(sweep.status),
        `sent ${formatEther(sweepAmount)}, ${formatEther(after)} left, ${sweep.transactionHash}`);
    } catch (err) {
      record("sweep", "leftover tBNB returned to the funder", false,
        String((err as Error).message).slice(0, 160));
    }
  } else {
    record("sweep", "leftover tBNB returned to the funder", true,
      `only ${formatEther(leftover)} tBNB left, below the fee margin, nothing worth sweeping`);
  }

  // Summary ----------------------------------------------------------------
  say("\n===================================================");
  say(`${IS_FORK ? "FORK" : "LIVE"} spine summary   (+${el()})`);
  say("===================================================");
  for (const r of results) say(`  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(6)} ${r.what}`);
  const failed = results.filter((r) => !r.pass);
  say(`\n  ${results.length - failed.length}/${results.length} passed`);
  if (!IS_FORK) {
    say(`\n  wallet   https://testnet.bscscan.com/address/${wallet.address}`);
  }
  say(`\n  wallet address: ${wallet.address}`);
  say(`  session keyHash: ${keyHash}`);
  if (failed.length) process.exit(1);
}

async function relayCall(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: any; error?: any };
  if (json.error) return json.error;
  return json.result;
}

main().catch((err) => {
  console.error("\nFAILED");
  console.error(err);
  process.exit(1);
});
