/**
 * Fee currency smoke test on Celo Sepolia (chain 11142220): a wallet pays the
 * relay in a stablecoin. CELO pays only the Keystore registration fee, which
 * the KeyStore takes in the chain's native token.
 *
 *   1. client.feeCurrencies(): the token is listed with a live rate
 *   2. createWallet (admin signer); fund it with the token, plus the CELO for
 *      two Keystore registrations (main key, session key) and nothing more
 *   3. execute(wallet, admin, ...) with no feeToken: CONFIRMED, result.feeToken
 *      is the token, the main key is registered in Celo Sepolia's KeyStore,
 *      and the wallet's CELO dropped by exactly one registration fee
 *   4. grantSession with `feeToken: [token]`: the session key is registered,
 *      the relay's fee comes out of the token and CELO dropped by exactly one
 *      more registration fee. Then execute(session) with nothing named: the
 *      session pays its fee in the token from the cap the grant added, and
 *      CELO does not move
 *   5. sweep: what is left of the token and of CELO goes back to the funder,
 *      pass or fail, as plain transfers from the wallet's own key. The key is
 *      saved to the shared testnet env file before any funds move.
 *   The whole sequence runs once per token under test (default usdc).
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY        funded on Celo Sepolia with CELO and the tokens under
 *                          test (USDC from https://faucet.circle.com, USDm/EURm/
 *                          KESm and CELO from https://faucet.celo.org/celo-sepolia)
 *   CELO_SEPOLIA_RPC_URL   optional override of the Celo Sepolia read RPC
 *   SMOKE_FEE_TOKENS       optional comma list of uids to prove (default usdc)
 *   SMOKE_FEE_AMOUNT       optional whole tokens to fund per run (default 2)
 *
 * Run: bun run smoke:celo-fee-currency   (from tests/e2e)
 */

import { appendFileSync } from "node:fs";
import {
  createClient,
  formatFeeAmount,
  signerFromPrivateKey,
  CELO_SEPOLIA,
  type FeeCurrency,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readActiveKeys, readIsValidKey, readRegistrationFee, registrationValueFor } from "../../packages/wallet/src/internal/keystore.js";
import { printLegs } from "./session-legs.js";
import { testnetEnvFile } from "./testnet-env.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key holding CELO and the stablecoins under test on Celo Sepolia " +
      "(USDC: https://faucet.circle.com; CELO, USDm, EURm, KESm: https://faucet.celo.org/celo-sepolia).",
  );
}

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};
const SYMBOL = network.chain.nativeCurrency.symbol;
const TOKENS = (process.env.SMOKE_FEE_TOKENS ?? "usdc").split(",").map((s) => s.trim());
const AMOUNT = process.env.SMOKE_FEE_AMOUNT ?? "2";

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
/** Reads a balance until it is below `before` (the same stale-node allowance as `settles`), and returns it. */
async function afterItDropped(read: () => Promise<bigint>, before: bigint, what: string): Promise<bigint> {
  let now = before;
  await settles(async () => (now = await read()) < before, what);
  return now;
}

async function main() {
  console.log("@altananetwork/sdk fee currency smoke test: Celo Sepolia");
  console.log("=========================================================\n");
  const t0 = performance.now();

  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const celo: PublicClient = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });
  const funderWallet = createWalletClient({ account: funder, chain: network.chain, transport: http(network.publicRpcUrl) });
  const client = createClient({ chains: [network] });

  // 1. What the relay accepts, live.
  console.log("[1] client.feeCurrencies()");
  const listed = await client.feeCurrencies();
  for (const c of listed.currencies) {
    console.log(`    ${c.symbol.padEnd(6)} ${c.address} dp=${c.decimals} 1 token = ${formatUnits(c.nativeRate, 18)} CELO`);
  }
  console.log(`    rateTtl: ${listed.rateTtl}s [${ms(t0)}]`);
  if (!listed.currencies[0]?.isNative) throw new Error("the native token must come first");

  const balanceOf = (token: Address, owner: Address) =>
    celo.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  const celoOf = (owner: Address) => celo.getBalance({ address: owner });

  // The Keystore registration fee is paid in CELO: one for the main key, one for the session key.
  const fee = await readRegistrationFee(celo, network);
  const celoAmount = registrationValueFor(fee) * 2n;
  console.log(`    registration fee: ${formatEther(fee)} ${SYMBOL} per key; the wallet gets ${formatEther(celoAmount)} ${SYMBOL} for two`);

  let proven = 0;
  for (const uid of TOKENS) {
    const currency: FeeCurrency | undefined = listed.currencies.find((c) => c.uid === uid && !c.isNative);
    if (!currency) throw new Error(`${uid} is not an accepted fee token on the relay: ${listed.currencies.map((c) => c.uid).join(", ")}`);
    const amount = parseUnits(AMOUNT, currency.decimals);
    const [funderHas, funderCelo] = await Promise.all([balanceOf(currency.address, funder.address), celoOf(funder.address)]);
    if (funderHas < amount) {
      throw new Error(
        `Fund ${funder.address} with at least ${AMOUNT} ${currency.symbol} on Celo Sepolia ` +
          `(holds ${formatUnits(funderHas, currency.decimals)}).`,
      );
    }
    if (funderCelo < celoAmount * 2n) {
      throw new Error(`Fund ${funder.address} with at least ${formatEther(celoAmount * 2n)} ${SYMBOL} on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
    }

    // 2. A fresh wallet. Its key is on file before it holds anything.
    console.log(`\n[2] ${currency.symbol}: createWallet, fund with ${AMOUNT} ${currency.symbol} and ${formatEther(celoAmount)} ${SYMBOL}`);
    const adminKey = generatePrivateKey();
    const admin = signerFromPrivateKey(adminKey);
    const wallet = await client.createWallet({ signer: admin });
    const tag = wallet.address.slice(2, 10).toUpperCase();
    appendFileSync(testnetEnvFile(), `\nSMOKE_CELO_FEE_${tag}_KEY=${adminKey}\n`);
    console.log(`    wallet ${wallet.address} (key saved as SMOKE_CELO_FEE_${tag}_KEY)`);

    try {
      // The funder's two transfers are numbered here: the public RPC can answer with a stale count.
      const nonce = await celo.getTransactionCount({ address: funder.address, blockTag: "pending" });
      const tokenTx = await funderWallet.writeContract({
        address: currency.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [wallet.address, amount],
        nonce,
      });
      const celoTx = await funderWallet.sendTransaction({ to: wallet.address, value: celoAmount, nonce: nonce + 1 });
      await Promise.all([celo.waitForTransactionReceipt({ hash: tokenTx }), celo.waitForTransactionReceipt({ hash: celoTx })]);
      await settles(async () => (await balanceOf(currency.address, wallet.address)) === amount, `the wallet holds ${AMOUNT} ${currency.symbol}`);
      await settles(async () => (await celoOf(wallet.address)) === celoAmount, `the wallet holds ${formatEther(celoAmount)} ${SYMBOL}, the two registrations and nothing more`);
      console.log(`    funded, tx ${tokenTx} and ${celoTx} [${ms(t0)}]`);

      // 3. Execute with no feeToken: the relay must pick this token. It is the
      //    wallet's first action, so it also registers the main key.
      console.log(`\n[3] execute(wallet, admin, sendZero) with no feeToken`);
      const result = await client.execute({ wallet, signer: admin, calls: { to: wallet.address, value: 0n, data: "0x" } });
      console.log(`    status: ${result.status} feeToken: ${result.feeToken} tx: ${result.transactionHash} [${ms(t0)}]`);
      check(result.status === "CONFIRMED", "the first action confirmed");
      check(result.feeToken?.toLowerCase() === currency.address.toLowerCase(), `the relay charged its fee in ${currency.symbol}`);
      const afterFirst = await afterItDropped(() => balanceOf(currency.address, wallet.address), amount, `the fee came out of the wallet's ${currency.symbol}`);
      console.log(`    fee paid: ${formatFeeAmount(amount - afterFirst, currency)}`);
      await settles(async () => (await readActiveKeys(celo, network, wallet.address)).length === 1, "the main key is registered in Celo Sepolia's KeyStore");
      await settles(async () => celoAmount - (await celoOf(wallet.address)) === fee, `CELO dropped by exactly one registration fee (${formatEther(fee)} ${SYMBOL})`);
      proven += 1;

      // 4. A registered session with a cap on this token, nothing named on
      //    execute: the SDK picks the capped token from the caps (porto would
      //    guess otherwise).
      console.log(`\n[4] grantSession with a ${currency.symbol} fee cap, then execute(session) with no feeToken`);
      const session = await client.grantSession({
        wallet,
        signer: admin,
        permissions: { calls: [{ to: wallet.address }], spend: [{ limit: 1n, period: "day" }] },
        expiry: Math.floor(Date.now() / 1000) + 3600,
        feeToken: [currency.address],
      });
      printLegs(session.legs);
      const capped = session.permissions.spend?.map((s) => s.token ?? "native").join(", ");
      console.log(`    caps on: ${capped} [${ms(t0)}]`);
      check(session.status === "granted", "the grant is granted");
      check(session.legs.every((l) => l.chainId === network.chainId), "every leg is on Celo Sepolia");
      await settles(() => readIsValidKey(celo, network, wallet.address, session.keyId), "the session key is valid in Celo Sepolia's KeyStore");
      const afterGrant = await afterItDropped(() => balanceOf(currency.address, wallet.address), afterFirst, `the grant's fee came out of the wallet's ${currency.symbol}`);
      console.log(`    grant fee paid: ${formatFeeAmount(afterFirst - afterGrant, currency)}`);
      await settles(async () => celoAmount - (await celoOf(wallet.address)) === fee * 2n, `CELO dropped by exactly one more registration fee`);

      const sessionExec = await client.execute({ session, calls: { to: wallet.address, value: 0n, data: "0x" } });
      console.log(`    status: ${sessionExec.status} feeToken: ${sessionExec.feeToken} tx: ${sessionExec.transactionHash} [${ms(t0)}]`);
      check(sessionExec.status === "CONFIRMED", "the session's transaction confirmed");
      check(sessionExec.feeToken?.toLowerCase() === currency.address.toLowerCase(), `the session paid its fee in ${currency.symbol}`);
      const afterSession = await afterItDropped(() => balanceOf(currency.address, wallet.address), afterGrant, `the session's fee came out of the wallet's ${currency.symbol}`);
      console.log(`    session fee paid: ${formatFeeAmount(afterGrant - afterSession, currency)}`);
      check(celoAmount - (await celoOf(wallet.address)) === fee * 2n, "the session spent no CELO");
    } finally {
      await sweep(celo, adminKey, currency, funder.address);
    }
  }

  if (proven === 0) throw new Error("no token was proven");
  console.log("\n=========================================================");
  console.log(`Proved ${proven} fee token(s): ${TOKENS.join(", ")}. Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

/**
 * Sends what is left in the wallet back to the funder, as plain transfers from
 * the wallet's own key: the token first, then CELO, which also pays for both.
 */
async function sweep(celo: PublicClient, adminKey: Hex, currency: FeeCurrency, funder: Address) {
  console.log(`\n[5] return leftover ${currency.symbol} and ${SYMBOL} to the funder`);
  try {
    const account = privateKeyToAccount(adminKey);
    const walletClient = createWalletClient({ account, chain: network.chain, transport: http(network.publicRpcUrl) });
    const gasPrice = await celo.getGasPrice();
    const fees = { maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice / 10n };
    let nonce = await celo.getTransactionCount({ address: account.address, blockTag: "pending" });

    const tokens = await celo.readContract({ address: currency.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    // Read once: a node that has not seen the token transfer yet would report the balance before its gas.
    let balance = await celo.getBalance({ address: account.address });
    const tokenGas = 120_000n;
    if (tokens > 0n && balance > tokenGas * fees.maxFeePerGas) {
      const hash = await walletClient.writeContract({
        address: currency.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [funder, tokens],
        gas: tokenGas,
        nonce: nonce++,
        ...fees,
      });
      await celo.waitForTransactionReceipt({ hash });
      balance -= tokenGas * fees.maxFeePerGas;
      console.log(`    returned ${formatFeeAmount(tokens, currency)} (${hash})`);
    } else if (tokens > 0n) {
      console.log(`    ${formatFeeAmount(tokens, currency)} left and no ${SYMBOL} to move it. The wallet's key is in the testnet env file.`);
    }

    // A delegated account runs code when it receives, not when it sends; a generous gas limit covers the transfer.
    const gas = 60_000n;
    const cost = gas * fees.maxFeePerGas;
    if (balance <= cost) {
      console.log(`    ${formatEther(balance)} ${SYMBOL} left: less than a transfer costs, nothing to return`);
      return;
    }
    const hash = await walletClient.sendTransaction({ to: funder, value: balance - cost, gas, nonce, ...fees });
    await celo.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(balance - cost)} ${SYMBOL} (${hash})`);
  } catch (err) {
    console.log(`    could not return the leftover: ${(err as Error).message.split("\n")[0]}. The wallet's key is in the testnet env file.`);
  }
}

main().catch((err) => {
  console.error(`\n${(err as Error).message}`);
  process.exit(1);
});
