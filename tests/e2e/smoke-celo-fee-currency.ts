/**
 * Fee currency smoke test on Celo Sepolia (chain 11142220): a wallet that
 * holds one accepted stablecoin and no CELO executes through the relay, and
 * the relay takes its fee in that stablecoin.
 *
 *   1. client.feeCurrencies(): the token is listed with a live rate
 *   2. createWallet (admin signer); fund it with the token only
 *   3. execute(wallet, admin, ...) with no feeToken: CONFIRMED, result.feeToken
 *      is the token, the wallet still holds no CELO, and the wallet's token
 *      balance dropped by at most the relay's quoted maximum
 *   4. grantSession with `feeToken: [token]` (register: false), then
 *      execute(session) with nothing named: the session pays its fee in the
 *      token from the cap the grant added, CELO still 0
 *   5. sweep: the leftover tokens go back to the funder through the relay,
 *      paying that transfer's fee in the token as well
 *   The whole sequence runs once per token under test (default usdc,eurm).
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY        funded on Celo Sepolia with the tokens under test
 *                          (USDC from https://faucet.circle.com, USDm/EURm/KESm
 *                          from https://faucet.celo.org/celo-sepolia); no CELO
 *                          is sent to the wallet
 *   CELO_SEPOLIA_RPC_URL   optional override of the Celo Sepolia read RPC
 *   SMOKE_FEE_TOKENS       optional comma list of uids to prove (default usdc,eurm)
 *   SMOKE_FEE_AMOUNT       optional whole tokens to fund per run (default 2)
 *
 * Run: bun run smoke:celo-fee-currency   (from tests/e2e)
 */

import {
  createClient,
  createPrivateKeySigner,
  formatFeeAmount,
  CELO_SEPOLIA,
  type FeeCurrency,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY: a key holding the stablecoins under test on Celo Sepolia " +
      "(USDC: https://faucet.circle.com; USDm, EURm, KESm: https://faucet.celo.org/celo-sepolia).",
  );
}

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};
const TOKENS = (process.env.SMOKE_FEE_TOKENS ?? "usdc,eurm").split(",").map((s) => s.trim());
const AMOUNT = process.env.SMOKE_FEE_AMOUNT ?? "2";

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

async function main() {
  console.log("@altananetwork/sdk fee currency smoke test: Celo Sepolia");
  console.log("=========================================================\n");
  const t0 = performance.now();

  const funder = privateKeyToAccount(TEST_FUNDER_KEY);
  const celo = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });
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

  let proven = 0;
  for (const uid of TOKENS) {
    const currency: FeeCurrency | undefined = listed.currencies.find((c) => c.uid === uid && !c.isNative);
    if (!currency) throw new Error(`${uid} is not an accepted fee token on the relay: ${listed.currencies.map((c) => c.uid).join(", ")}`);
    const amount = parseUnits(AMOUNT, currency.decimals);
    const funderHas = await balanceOf(currency.address, funder.address);
    if (funderHas < amount) {
      throw new Error(
        `Fund ${funder.address} with at least ${AMOUNT} ${currency.symbol} on Celo Sepolia ` +
          `(holds ${formatUnits(funderHas, currency.decimals)}).`,
      );
    }

    // 2. A fresh wallet holding this token and nothing else.
    console.log(`\n[2] ${currency.symbol}: createWallet, fund with ${AMOUNT} ${currency.symbol} only`);
    const adminSigner = createPrivateKeySigner();
    const wallet = await client.createWallet({ signer: adminSigner });
    const fundTx = await funderWallet.writeContract({
      address: currency.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [wallet.address, amount],
    });
    await celo.waitForTransactionReceipt({ hash: fundTx });
    console.log(`    wallet ${wallet.address} funded, tx ${fundTx} [${ms(t0)}]`);
    if ((await celo.getBalance({ address: wallet.address })) !== 0n) throw new Error("the wallet must hold no CELO");

    // 3. Execute with no feeToken: the relay must pick this token.
    console.log(`\n[3] execute(wallet, admin, sendZero) with no feeToken`);
    const before = await balanceOf(currency.address, wallet.address);
    const result = await client.execute({ wallet, signer: adminSigner, calls: { to: wallet.address, value: 0n, data: "0x" } });
    console.log(`    status: ${result.status} feeToken: ${result.feeToken} tx: ${result.transactionHash} [${ms(t0)}]`);
    if (result.status !== "CONFIRMED") throw new Error(`execute failed: ${JSON.stringify(result)}`);
    if (result.feeToken?.toLowerCase() !== currency.address.toLowerCase()) {
      throw new Error(`the relay charged ${result.feeToken}, expected ${currency.symbol} ${currency.address}`);
    }
    const after = await balanceOf(currency.address, wallet.address);
    const paid = before - after;
    if (paid <= 0n) throw new Error("no fee was taken from the wallet's token balance");
    if ((await celo.getBalance({ address: wallet.address })) !== 0n) throw new Error("the wallet spent CELO it did not have");
    console.log(`    fee paid: ${formatFeeAmount(paid, currency)}; CELO balance still 0`);
    proven += 1;

    // 4. A session with a cap on this token, nothing named on execute: the SDK
    //    picks the capped token from the caps (porto would guess otherwise).
    //    register: false keeps the registry write, which needs Sepolia ETH,
    //    out of a test that is about the fee.
    console.log(`\n[4] grantSession with a ${currency.symbol} fee cap, then execute(session) with no feeToken`);
    const session = await client.grantSession({
      wallet,
      signer: adminSigner,
      permissions: { calls: [{ to: wallet.address }], spend: [{ limit: 1n, period: "day" }] },
      expiry: Math.floor(Date.now() / 1000) + 3600,
      register: false,
      feeToken: [currency.address],
    });
    const capped = session.permissions.spend?.map((s) => s.token ?? "native").join(", ");
    const accountLeg = session.legs.find((l) => l.kind === "account");
    console.log(`    granted, caps on: ${capped}, tx ${accountLeg?.transactionHash} [${ms(t0)}]`);
    if (session.status !== "granted") {
      const why = session.legs.map((l) => `${l.kind}@${l.chainId} ${l.status}${l.reason ? ` (${l.reason})` : ""}`).join("; ");
      throw new Error(`grant failed: ${why}`);
    }
    const sessionBefore = await balanceOf(currency.address, wallet.address);
    const sessionExec = await client.execute({ session, calls: { to: wallet.address, value: 0n, data: "0x" } });
    console.log(`    status: ${sessionExec.status} feeToken: ${sessionExec.feeToken} tx: ${sessionExec.transactionHash} [${ms(t0)}]`);
    if (sessionExec.status !== "CONFIRMED") throw new Error(`session execute failed: ${JSON.stringify(sessionExec)}`);
    if (sessionExec.feeToken?.toLowerCase() !== currency.address.toLowerCase()) {
      throw new Error(`the session paid in ${sessionExec.feeToken}, expected ${currency.symbol}`);
    }
    const sessionPaid = sessionBefore - (await balanceOf(currency.address, wallet.address));
    if (sessionPaid <= 0n) throw new Error("the session's fee did not come out of the token balance");
    if ((await celo.getBalance({ address: wallet.address })) !== 0n) throw new Error("the session spent CELO the wallet did not have");
    console.log(`    session fee paid: ${formatFeeAmount(sessionPaid, currency)}; CELO balance still 0`);

    // 5. Sweep the leftover back to the funder, fee in the token again.
    console.log(`\n[5] sweep ${currency.symbol} back to the funder through the relay`);
    const reserve = paid * 4n;
    const leftover = after > reserve ? after - reserve : 0n;
    if (leftover > 0n) {
      const sweep = await client.execute({
        wallet,
        signer: adminSigner,
        calls: {
          to: currency.address,
          value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [funder.address, leftover] }),
        },
      });
      console.log(`    status: ${sweep.status} feeToken: ${sweep.feeToken} tx: ${sweep.transactionHash} [${ms(t0)}]`);
      if (sweep.status !== "CONFIRMED") throw new Error("sweep failed; the wallet keeps its leftover tokens");
    }
    console.log(`    dust left in the wallet: ${formatFeeAmount(await balanceOf(currency.address, wallet.address), currency)}`);
  }

  if (proven === 0) throw new Error("no token was proven");
  console.log("\n=========================================================");
  console.log(`Proved ${proven} fee token(s): ${TOKENS.join(", ")}. Total wall-clock: ${ms(t0)}`);
  console.log("Result: PASS ✓");
}

main().catch((err) => {
  console.error("\nCelo Sepolia fee currency smoke test crashed:", err);
  process.exit(1);
});
