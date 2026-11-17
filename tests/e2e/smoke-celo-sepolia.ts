/**
 * Session-key smoke test on Celo Sepolia (chain 11142220). Celo Sepolia keeps
 * its own KeyStore: keys are registered on Celo Sepolia, in the same request
 * that authorizes them, and the registration fee is paid in CELO.
 *
 *   1. createWallet (admin signer); the key is saved to the shared testnet env
 *      file before the wallet is sent anything
 *   2. fund the wallet with CELO on Celo Sepolia: three registration fees with
 *      the SDK's margin, plus gas
 *   3. quoteGrantSession: one line, on Celo Sepolia, carrying both registrations
 *   4. grantSession, the wallet's first action: one request registers the main
 *      key and the session key in Celo Sepolia's KeyStore and authorizes the
 *      session
 *   5. execute(session, ...) as the agent
 *   6. a second grantSession: one more key, no main key this time
 *   7. revokeSession of the first session: the account and the KeyStore in one
 *      request; the revoked session is refused afterwards
 *   8. nothing was written on Sepolia
 *   9. leftover CELO goes back to the funder
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY       funded with CELO on Celo Sepolia
 *                         (https://faucet.celo.org/celo-sepolia)
 *   CELO_SEPOLIA_RPC_URL  optional override of the Celo Sepolia read RPC
 *   RELAY_URL             optional override of the relay (a local build)
 *
 * Run: bun run smoke:celo-sepolia   (from tests/e2e)
 */

import { appendFileSync } from "node:fs";
import {
  createClient,
  formatQuoteLine,
  isCachedRegistry,
  registryNetwork,
  signerFromPrivateKey,
  CELO_SEPOLIA,
  SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readActiveKeys, readIsValidKey, readRegistrationFee, registrationValueFor } from "../../packages/wallet/src/internal/keystore.js";
import { assertStatus, legOf, printLegs } from "./session-legs.js";
import { testnetEnvFile } from "./testnet-env.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error("Set TEST_FUNDER_KEY: a key funded with CELO on Celo Sepolia (https://faucet.celo.org/celo-sepolia).");
}

// RELAY_URL points the chain at another relay (a local build, for instance).
const celoSepolia: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  ...(process.env.RELAY_URL ? { relayUrl: process.env.RELAY_URL } : {}),
};
const CHAIN_ID = celoSepolia.chainId;
const SYMBOL = celoSepolia.chain.nativeCurrency.symbol;
const CONTROLLER_ABI = [{ name: "treasury", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}
function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`    ok: ${what}`);
}

async function main() {
  console.log("@altananetwork/sdk session smoke test: Celo Sepolia (its own KeyStore)");
  console.log("======================================================================\n");
  const t0 = performance.now();
  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const celoPublic: PublicClient = createPublicClient({ chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
  const sepoliaPublic: PublicClient = createPublicClient({ chain: SEPOLIA.chain, transport: http(process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl) });
  const celoFunder = createWalletClient({ account: funder, chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });

  check(!isCachedRegistry(celoSepolia) && registryNetwork(celoSepolia).chainId === CHAIN_ID, "Celo Sepolia is its own registry in the SDK config");
  const code = await celoPublic.getCode({ address: celoSepolia.keyStore });
  check(code && code !== "0x", `the KeyStore is deployed at ${celoSepolia.keyStore}`);
  const fee = await readRegistrationFee(celoPublic, celoSepolia);
  const treasury = await celoPublic.readContract({ address: celoSepolia.keyStoreController, abi: CONTROLLER_ABI, functionName: "treasury" });
  console.log(`registration fee: ${formatEther(fee)} ${SYMBOL} per key; treasury ${treasury}`);

  // Three registrations with the SDK's margin (two in the first grant, one in the second), plus gas.
  const budget = registrationValueFor(fee) * 3n + parseEther("0.4");
  const funderBalance = await celoPublic.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} ${SYMBOL}; this run sends ${formatEther(budget)}`);
  if (funderBalance < budget + parseEther("0.05")) {
    throw new Error(`Fund ${funder.address} with at least ${formatEther(budget + parseEther("0.05"))} ${SYMBOL} on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
  }

  // 1. Create the wallet. Its key is on file before it holds anything.
  console.log("\n[1] createWallet");
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [celoSepolia] });
  const wallet = await client.createWallet({ signer: admin });
  const tag = wallet.address.slice(2, 10).toUpperCase();
  appendFileSync(testnetEnvFile(), `\nSMOKE_CELO_KEYSTORE_${tag}_KEY=${adminKey}\n`);
  console.log(`    wallet ${wallet.address} (key saved as SMOKE_CELO_KEYSTORE_${tag}_KEY)`);

  try {
    // 2. Fund it with CELO only.
    console.log("\n[2] fund the wallet with CELO");
    const fundTx = await celoFunder.sendTransaction({ to: wallet.address, value: budget });
    await celoPublic.waitForTransactionReceipt({ hash: fundTx });
    console.log(`    sent ${formatEther(budget)} ${SYMBOL} [${ms(t0)}]`);
    const sepoliaNonceBefore = await sepoliaPublic.getTransactionCount({ address: wallet.address });
    const treasuryBefore = await celoPublic.getBalance({ address: treasury });

    const permissions = { calls: [{ to: funder.address }], spend: [{ limit: parseEther("0.01"), period: "day" as const }] };
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // 3. Quote the first grant.
    console.log("\n[3] quoteGrantSession");
    const firstSigner = signerFromPrivateKey(generatePrivateKey());
    const quote = await client.quoteGrantSession({ wallet, signer: admin, sessionSigner: firstSigner, permissions, expiry, chainId: CHAIN_ID });
    for (const line of quote.lines) console.log(`    ${formatQuoteLine(line, celoSepolia).split("\n")[0]}`);
    check(quote.lines.every((l) => l.chainId === CHAIN_ID), "every quoted line is on Celo Sepolia");
    check(quote.lines.some((l) => l.kind === "account" && l.value === registrationValueFor(fee) * 2n), "the grant's line carries both registrations (main key and session key)");
    check(quote.balances.every((b) => b.sufficient), "the wallet can pay what the quote asks");

    // 4. First grant: the wallet's first action.
    console.log("\n[4] grantSession (first action: main key + session key + authorization, one request)");
    const first = await client.grantSession({ wallet, signer: admin, sessionSigner: firstSigner, permissions, expiry, chainId: CHAIN_ID });
    printLegs(first.legs);
    assertStatus(first, "granted", "first grant");
    check(first.legs.every((l) => l.chainId === CHAIN_ID), "every leg is on Celo Sepolia");
    check(legOf(first.legs, "registry", CHAIN_ID).via === "bundled", "the registration rides in the account's own request");
    check(!first.legs.some((l) => l.kind === "cache"), "there is no mirror step");
    check((await readActiveKeys(celoPublic, celoSepolia, wallet.address)).length === 2, "Celo Sepolia's KeyStore holds two keys for the wallet");
    check(await readIsValidKey(celoPublic, celoSepolia, wallet.address, first.keyId), "the session key is valid in Celo Sepolia's KeyStore");
    console.log(`    tx ${celoSepolia.explorer}/tx/${first.transactionHash} [${ms(t0)}]`);

    // 5. The agent uses the session.
    console.log("\n[5] execute(session)");
    const used = await client.execute({ session: first, calls: { to: funder.address, value: 1n, data: "0x" } });
    check(used.status === "CONFIRMED", `the session's transaction confirmed (${used.transactionHash})`);

    // 6. A second grant: one more key.
    console.log("\n[6] grantSession (second: one more key)");
    const second = await client.grantSession({ wallet, signer: admin, sessionSigner: signerFromPrivateKey(generatePrivateKey()), permissions, expiry, chainId: CHAIN_ID });
    printLegs(second.legs);
    assertStatus(second, "granted", "second grant");
    check((await readActiveKeys(celoPublic, celoSepolia, wallet.address)).length === 3, "the KeyStore now holds three keys");
    const received = (await celoPublic.getBalance({ address: treasury })) - treasuryBefore;
    // When the funder is also the treasury, its own gas and the wallet's 1 wei blur the figure; three fees is the floor either way.
    if (treasury.toLowerCase() !== funder.address.toLowerCase()) check(received === fee * 3n, `the treasury received exactly three fees (${formatEther(received)} ${SYMBOL})`);

    // 7. Revoke the first session.
    console.log("\n[7] revokeSession (first session)");
    const revoked = await client.revokeSession({ wallet, signer: admin, session: first });
    printLegs(revoked.legs);
    assertStatus(revoked, "revoked", "revoke");
    check(revoked.legs.every((l) => l.chainId === CHAIN_ID), "the revoke acted on Celo Sepolia only");
    check(!(await readIsValidKey(celoPublic, celoSepolia, wallet.address, first.keyId)), "the revoked key is no longer valid in the KeyStore");
    check(await readIsValidKey(celoPublic, celoSepolia, wallet.address, second.keyId), "the second session key is still valid");
    let afterRevoke = "refused";
    try {
      const again = await client.execute({ session: first, calls: { to: funder.address, value: 1n, data: "0x" } });
      afterRevoke = again.status;
    } catch {
      /* refused, as it should be */
    }
    check(afterRevoke !== "CONFIRMED", "the revoked session can no longer transact");

    // 8. Sepolia was never touched.
    console.log("\n[8] nothing on Sepolia");
    check((await sepoliaPublic.getTransactionCount({ address: wallet.address })) === sepoliaNonceBefore, "the wallet sent nothing on Sepolia");
    check((await readActiveKeys(sepoliaPublic, SEPOLIA, wallet.address)).length === 0, "the Sepolia KeyStore holds no key for the wallet");
  } finally {
    await sweep(celoPublic, adminKey, wallet.address, funder.address);
  }
  console.log(`\nPASS [${ms(t0)}]`);
}

/** Sends what is left in the wallet back to the funder, as a plain transfer from the wallet's own key. */
async function sweep(celoPublic: PublicClient, adminKey: Hex, wallet: Address, funder: Address) {
  console.log("\n[9] return leftover CELO to the funder");
  try {
    const account = privateKeyToAccount(adminKey);
    const walletClient = createWalletClient({ account, chain: celoSepolia.chain, transport: http(celoSepolia.publicRpcUrl) });
    const [balance, gasPrice] = await Promise.all([celoPublic.getBalance({ address: wallet }), celoPublic.getGasPrice()]);
    // A delegated account runs code when it receives, not when it sends; a generous gas limit covers the transfer.
    const gas = 60_000n;
    const cost = gas * gasPrice * 2n;
    if (balance <= cost) {
      console.log(`    ${formatEther(balance)} ${SYMBOL} left: less than a transfer costs, nothing to return`);
      return;
    }
    const hash = await walletClient.sendTransaction({ to: funder, value: balance - cost, gas, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice / 10n });
    await celoPublic.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(balance - cost)} ${SYMBOL} (${hash})`);
  } catch (err) {
    console.log(`    could not return the leftover: ${(err as Error).message.split("\n")[0]}. The wallet's key is in the testnet env file.`);
  }
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
