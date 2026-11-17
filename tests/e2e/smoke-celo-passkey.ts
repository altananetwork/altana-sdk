/**
 * Passkey smoke test on Celo Sepolia (chain 11142220), headless variant so it
 * runs in Node:
 *   1. createHeadlessPasskey() -> PasskeySigner
 *   2. createWallet({ signer: passkey }): throwaway secp256k1 signs the
 *      EIP-7702 setCode, the passkey becomes the admin authority
 *   3. fund the wallet with CELO, and with nothing on any other chain
 *   4. execute(wallet, passkey, sendOneWei): the P256 signature is verified
 *      by the account through the P256 canary on Celo Sepolia. It is the
 *      wallet's first action, so it also registers the passkey in Celo
 *      Sepolia's KeyStore, the fee paid in CELO.
 *   5. grantSession(wallet, passkey): a registered grant, the session key
 *      registered in the same request; then grantSession({ register: false }):
 *      an account-only session. The account enforces permissions/expiry on both.
 *   6. execute(session, ...): the session-key path under a passkey admin
 *   7. revokeSession(wallet, passkey, session) for both sessions; the
 *      registered one is revoked in the KeyStore in the same request
 *   8. nothing was sent on Sepolia, and the Sepolia KeyStore holds no key
 *   9. sweep: what is left goes back to the funder, pass or fail, signed by
 *      the passkey. The credential is appended to the shared testnet env file
 *      before any funds move, because it is the only key that can ever sign
 *      for this wallet.
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY   funded with CELO on Celo Sepolia (>= 4 CELO,
 *                     https://faucet.celo.org/celo-sepolia)
 *   CELO_SEPOLIA_RPC_URL  optional override of the Celo Sepolia read RPC
 *   SEPOLIA_RPC_URL       optional override of the Sepolia read RPC
 *   SMOKE_CELO_FEE_HEADROOM  CELO sent on top of the two registrations, for
 *                     the relay's fees (default 2.6); the rest is returned
 *
 * Run: bun run smoke:celo-passkey   (from tests/e2e)
 */

import {
  createClient,
  createHeadlessPasskey,
  quoteCalls,
  waitForBalance,
  CELO_SEPOLIA,
  SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createClient as createViemClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { readActiveKeys, readIsValidKey, readRegistrationFee, registrationValueFor } from "../../packages/wallet/src/internal/keystore.js";
import { testnetEnvFile } from "./testnet-env.js";
import { assertStatus, legOf, printLegs } from "./session-legs.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia (https://faucet.celo.org/celo-sepolia).",
  );
}

const celoSepolia: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};

const CHAIN_ID = celoSepolia.chainId;
const SYMBOL = celoSepolia.chain.nativeCurrency.symbol;

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`    ok: ${what}`);
}
/**
 * A check on chain state made right after a write. The public RPC is
 * load-balanced, and a node that has not seen the write's block yet answers
 * with the state before it. So the read is repeated until it shows the
 * expected state, for up to 30 seconds.
 */
async function settles(read: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await read().catch(() => false)) return check(true, what);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  check(false, what);
}

async function main() {
  console.log("@altananetwork/sdk passkey smoke test: Celo Sepolia");
  console.log("==================================================\n");

  const t0 = performance.now();
  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const celoPublic = createPublicClient({ chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const celoFunder = createWalletClient({ account: funder, chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const sepoliaPublic = createPublicClient({ chain: SEPOLIA.chain, transport: http(process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl) });

  // Two Keystore registrations are paid in CELO (the passkey, then the session
  // key), each sent with the SDK's margin, which comes back. The rest is for
  // the relay's fees: the testnet relay quotes each request with a large gas
  // allowance and the wallet must hold the quoted maximum every time.
  const fee = await readRegistrationFee(celoPublic, celoSepolia);
  const CELO_FUNDING = registrationValueFor(fee) * 2n + parseEther(process.env.SMOKE_CELO_FEE_HEADROOM ?? "2.6");
  const bal = await celoPublic.getBalance({ address: funder.address });
  console.log(`registration fee: ${formatEther(fee)} ${SYMBOL} per key`);
  console.log(`funder ${funder.address}: ${formatEther(bal)} ${SYMBOL} on Celo Sepolia; this run sends ${formatEther(CELO_FUNDING)}`);
  if (bal < CELO_FUNDING + parseEther("0.02")) {
    throw new Error(`Fund ${funder.address} with at least ${formatEther(CELO_FUNDING + parseEther("0.02"))} ${SYMBOL} on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
  }

  // 1. Passkey signer (headless for Node)
  console.log("\n[1] createHeadlessPasskey");
  const passkey = createHeadlessPasskey();
  console.log("    type:        ", passkey.type);
  console.log("    publicKey:   ", passkey.publicKey.slice(0, 24) + "...");

  // 2. Wallet: throwaway-EOA bootstrap, passkey as admin
  console.log("\n[2] createWallet({ signer: passkey })");
  const client = createClient({ chains: [celoSepolia] });
  const wallet = await client.createWallet({ signer: passkey });
  console.log("    wallet.address:", wallet.address);
  console.log(`    upgraded [${ms(t0)}]`);

  // A headless passkey's P256 key lives only in this process, and the throwaway
  // that owns the address is discarded at creation. Persist the credential
  // before any funds move: it is the only key that can ever sign for this
  // wallet, and `signerFromPasskey(credential)` rebuilds it.
  savePasskeyCredential(wallet.address, passkey.credential);

  const sepoliaNonceBefore = await sepoliaPublic.getTransactionCount({ address: wallet.address });

  const run = async () => {
  // 3. Fund
  console.log(`\n[3] Fund the wallet with ${formatEther(CELO_FUNDING)} ${SYMBOL} on Celo Sepolia`);
  const fundTx = await celoFunder.sendTransaction({ to: wallet.address, value: CELO_FUNDING });
  await celoPublic.waitForTransactionReceipt({ hash: fundTx });
  // A receipt is not a visible balance: forno has answered 0 for a wallet whose
  // funding transaction had already confirmed, and the relay then quotes the
  // first intent as unpayable. Wait for the balance itself.
  await waitForBalance(celoPublic, wallet.address, CELO_FUNDING, 120_000);
  console.log(`    funded [${ms(t0)}]`);

  // 4. First execute: P256 signature verified on Celo Sepolia (P256 canary)
  console.log("\n[4] execute(wallet, passkey, sendOneWei)");
  const firstExec = await client.execute({ wallet, signer: passkey, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", firstExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", firstExec.transactionHash);
  if (firstExec.status !== "CONFIRMED") throw new Error("First execute failed");
  await settles(async () => (await readActiveKeys(celoPublic, celoSepolia, wallet.address)).length === 1, "the passkey is registered in Celo Sepolia's KeyStore");

  // 5a. A registered grant: the session key is registered in the same request, signed by the passkey.
  console.log("\n[5a] grantSession (passkey admin, session key registered on Celo Sepolia)");
  const registered = await client.grantSession({
    wallet,
    signer: passkey,
    permissions: { calls: [{ to: funder.address }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  printLegs(registered.legs);
  assertStatus(registered, "granted", "registered grantSession");
  check(registered.legs.every((l) => l.chainId === CHAIN_ID), "every leg is on Celo Sepolia");
  check(legOf(registered.legs, "registry", CHAIN_ID).via === "bundled", "the registration rides in the account's own request");
  check(!registered.legs.some((l) => l.kind === "cache"), "there is no mirror step");
  await settles(() => readIsValidKey(celoPublic, celoSepolia, wallet.address, registered.keyId), "the session key is valid in Celo Sepolia's KeyStore");

  // 5b. Account-only session
  console.log("\n[5b] grantSession({ register: false }) (1h, scoped to funder, 1 CELO/day)");
  const session = await client.grantSession({
    wallet,
    signer: passkey,
    register: false,
    permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("1"), period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
    onStatus: (s) => console.log(`    status: ${s} [${ms(t0)}]`),
  });
  printLegs(session.legs);
  assertStatus(session, "granted", "grantSession");
  check(!session.legs.some((l) => l.kind === "registry" || l.kind === "cache"), "register: false writes nothing to the KeyStore");
  check((await readActiveKeys(celoPublic, celoSepolia, wallet.address)).length === 2, "the KeyStore still holds two keys (the passkey and the registered session)");
  console.log(`    granted [${ms(t0)}]`);

  // 6. Execute as the session
  console.log("\n[6] execute(session, sendOneWei) under the passkey admin");
  const sessionExec = await client.execute({ session, calls: { to: funder.address, value: 1n, data: "0x" } });
  console.log("    status:", sessionExec.status, `[${ms(t0)}]`);
  console.log("    tx:    ", sessionExec.transactionHash);
  if (sessionExec.status !== "CONFIRMED") throw new Error("session execute failed");

  // 7. Revoke
  console.log("\n[7] revokeSession (passkey admin)");
  const revokeRes = await client.revokeSession({ wallet, signer: passkey, session });
  console.log("    status:", revokeRes.status, `[${ms(t0)}]`);
  printLegs(revokeRes.legs);
  assertStatus(revokeRes, "revoked", "revokeSession");
  const revokeRegistered = await client.revokeSession({ wallet, signer: passkey, session: registered });
  printLegs(revokeRegistered.legs);
  assertStatus(revokeRegistered, "revoked", "revokeSession (registered session)");
  check(revokeRegistered.legs.every((l) => l.chainId === CHAIN_ID), "the revoke acted on Celo Sepolia only");
  await settles(async () => !(await readIsValidKey(celoPublic, celoSepolia, wallet.address, registered.keyId)), "the revoked key is no longer valid in the KeyStore");

  // 8. Sepolia was never touched.
  console.log("\n[8] nothing on Sepolia");
  check((await sepoliaPublic.getTransactionCount({ address: wallet.address })) === sepoliaNonceBefore, "the wallet sent nothing on Sepolia");
  check((await readActiveKeys(sepoliaPublic, SEPOLIA, wallet.address)).length === 0, "the Sepolia KeyStore holds no key for the wallet");
  };

  // The sweep runs pass or fail: leftover testnet funds go back to the funder.
  try {
    await run();
  } finally {
    console.log("\n[9] return leftover funds to the funder");
    await sweepBack(celoSepolia, celoPublic, passkey, wallet, funder.address);
  }

  console.log("\n==================================================");
  console.log(`Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

/**
 * The passkey credential, appended to the shared testnet env file so the
 * wallet's funds stay reachable if the run dies before the sweep.
 */
function savePasskeyCredential(address: Address, credential: unknown) {
  const file = testnetEnvFile();
  appendFileSync(
    file,
    `\n# smoke-celo-passkey wallet ${address}, ${new Date().toISOString()}: headless passkey credential\n` +
      `SMOKE_PASSKEY_${address.slice(2, 10).toUpperCase()}_CREDENTIAL='${JSON.stringify(credential)}'\n`,
  );
  console.log("    passkey credential saved to the shared testnet env file");
}

/**
 * Sends what is left on one chain back to the funder, sized from the relay's
 * own quote for the transfer. The passkey signs it, which is also the only way
 * out of a passkey wallet: there is no EOA key to send from. Best effort,
 * logged, never throws.
 */
async function sweepBack(
  network: NetworkConfig,
  publicClient: PublicClient,
  passkey: ReturnType<typeof createHeadlessPasskey>,
  wallet: { address: Address },
  funder: Address,
) {
  const symbol = network.chain.nativeCurrency.symbol;
  try {
    const balance = await publicClient.getBalance({ address: wallet.address });
    if (balance === 0n) {
      console.log(`    ${network.chain.name}: nothing left`);
      return;
    }
    const relay = createViemClient({ chain: network.chain, transport: http(network.relayUrl!) });
    const probe = await quoteCalls(relay, wallet.address, passkey, [{ to: funder, value: 1n, data: "0x" }], {
      feeToken: "0x0000000000000000000000000000000000000000",
      submittingKey: { type: "webauthn-p256", signer: passkey, role: "admin" },
      network,
    });
    const fee = probe.nativeNeeded - 1n;
    const amount = balance - (fee * 13n) / 10n;
    if (amount <= 0n) {
      console.log(
        `    ${network.chain.name}: ${formatEther(balance)} ${symbol} left, below the transfer fee ` +
          `(${formatEther(fee)}); kept`,
      );
      return;
    }
    const res = await createClient({ chains: [network] }).execute({
      wallet,
      signer: passkey,
      calls: { to: funder, value: amount, data: "0x" },
    });
    console.log(
      `    ${network.chain.name}: returned ${formatEther(amount)} ${symbol} ` +
        `(${res.status}${res.transactionHash ? ` ${res.transactionHash}` : ""})`,
    );
  } catch (err) {
    console.log(
      `    ${network.chain.name}: sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`,
    );
  }
}

main().catch((err) => {
  console.error("\nCelo Sepolia passkey smoke test crashed:", err);
  process.exit(1);
});
