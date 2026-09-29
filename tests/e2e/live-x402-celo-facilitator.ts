/**
 * LIVE (Celo Sepolia) — Celo's own x402 facilitator, against a real challenge
 * from `@altananetwork/x402-server` and real signatures.
 *
 * Celo hosts the facilitator its docs point at
 * (https://docs.celo.org/build-on-celo/build-with-ai/x402):
 *
 *   mainnet   https://api.x402.celo.org
 *   sepolia   https://api.x402.sepolia.celo.org
 *
 * `/supported` and `/verify` are open; `/settle` needs an `X-API-Key`, issued
 * at https://x402.celo.org against a signed message. So this proves everything
 * up to the authenticated broadcast without a key, and the broadcast too when
 * `X402_CELO_API_KEY` is set.
 *
 * What it answers, and neither is guessable from the docs:
 *
 *   1. Does the facilitator accept a payment built from **our** merchant's
 *      challenge, unchanged? (the wire compatibility question)
 *   2. Can an **Altana smart account** pay through it, or only a plain EOA?
 *      Celo's `exact` scheme settles EIP-3009, and whether its verifier is
 *      ERC-1271-aware decides whether an agent wallet can use it at all.
 *
 * Money: buyer A is the shared funder's own EOA, paying 0.01 USDC to a
 * throwaway payout address. `/verify` moves nothing. A `/settle` with a key
 * does move it, and the payout key is written to the shared testnet env file
 * first.
 *
 * Needs:
 *   TEST_FUNDER_KEY        holding USDC on Celo Sepolia (>= 0.05)
 *   X402_CELO_API_KEY      optional; without it /settle is skipped
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *
 * Run: bun run live:x402-celo-facilitator   (from tests/e2e)
 */
import {
  buildEip3009TypedData,
  createClient,
  signerFromPrivateKey,
  signX402Payment,
  waitForBalance,
  CELO_SEPOLIA,
  type NetworkConfig,
  type X402Requirement,
} from "@altananetwork/sdk";
import {
  buildChallenge,
  facilitatorSupported,
  supportsExactOn,
  USDC_CELO_SEPOLIA,
  CELO_SEPOLIA_FACILITATOR_URL,
  type MerchantConfig,
} from "@altananetwork/x402-server";
import { createPublicClient, createWalletClient, encodeFunctionData, formatUnits, http, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const FACILITATOR = process.env.X402_CELO_FACILITATOR_URL ?? CELO_SEPOLIA_FACILITATOR_URL;
const API_KEY = process.env.X402_CELO_API_KEY;
const PRICE = parseUnits("0.01", USDC_CELO_SEPOLIA.decimals);

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};
const publicClient = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const usdc = (raw: bigint) => `${formatUnits(raw, USDC_CELO_SEPOLIA.decimals)} USDC`;

async function balanceOf(address: Address): Promise<bigint> {
  return publicClient.readContract({ address: USDC_CELO_SEPOLIA.address, abi: ERC20, functionName: "balanceOf", args: [address] });
}

/** POST a payment to the facilitator and return its answer verbatim. */
async function post(path: "verify" | "settle", header: string, requirement: X402Requirement) {
  const response = await fetch(`${FACILITATOR}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(path === "settle" && API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: JSON.parse(Buffer.from(header, "base64").toString("utf8")),
      paymentRequirements: requirement,
    }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body as Record<string, unknown> };
}

async function main() {
  console.log("LIVE x402 through Celo's facilitator — Celo Sepolia");
  console.log("==================================================\n");
  console.log(`facilitator ${FACILITATOR}`);

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const funderWallet = createWalletClient({ account: funder, chain: network.chain, transport: http(network.publicRpcUrl) });

  // ── 1. What the facilitator says it takes. ──
  const supported = await facilitatorSupported({ url: FACILITATOR });
  console.log(`\n[1] GET /supported`);
  for (const kind of supported.kinds) console.log(`    ${kind.scheme} on ${kind.network} (x402 v${kind.x402Version ?? "?"})`);
  if (supported.extensions?.length) console.log(`    extensions: ${supported.extensions.join(", ")}`);
  assert(supportsExactOn(supported.kinds, network.chainId), `the facilitator takes "exact" on eip155:${network.chainId}`);

  // ── 2. A real challenge from our own merchant, for the USDC eip3009 rail. ──
  const payoutKey = generatePrivateKey();
  const payout = privateKeyToAccount(payoutKey);
  savePayoutKey(payout.address, payoutKey);
  const merchant: MerchantConfig = {
    chainId: network.chainId,
    payTo: payout.address,
    price: PRICE,
    rails: [{ rail: "eip3009", token: USDC_CELO_SEPOLIA }],
    resource: "https://api.altana.network/x402-celo-probe",
    description: "Celo facilitator probe",
  };
  const challenge = buildChallenge(merchant);
  const requirement = challenge.accepts[0]! as unknown as X402Requirement;
  console.log(`\n[2] challenge from @altananetwork/x402-server`);
  console.log(`    ${requirement.scheme} on ${requirement.network}, ${usdc(PRICE)} of ${requirement.asset} to ${requirement.payTo}`);

  const funderUsdc = await balanceOf(funder.address);
  console.log(`    funder holds ${usdc(funderUsdc)}`);
  assert(funderUsdc >= PRICE * 5n, `the funder holds at least ${usdc(PRICE * 5n)} on Celo Sepolia`);

  // ── 3. Buyer A: a plain EOA. This is the baseline x402 buyer. ──
  console.log(`\n[3] buyer A, a plain EOA (${funder.address}): /verify`);
  const headerA = await eoaPayment(funder, requirement);
  const verifyA = await post("verify", headerA, requirement);
  console.log(`    ${verifyA.status} ${JSON.stringify(verifyA.body)}`);
  assert(verifyA.body.isValid === true, `the facilitator accepts an EOA payment built from our challenge (${JSON.stringify(verifyA.body)})`);

  // ── 4. Buyer B: an Altana smart account. Whether the facilitator's verifier
  // is ERC-1271-aware decides whether an agent wallet can use it at all. ──
  console.log(`\n[4] buyer B, an Altana smart account: /verify`);
  const smart = await smartAccountPayment(requirement, funderWallet);
  const verifyB = await post("verify", smart.header, requirement);
  console.log(`    wallet ${smart.wallet}`);
  console.log(`    ${verifyB.status} ${JSON.stringify(verifyB.body)}`);
  if (verifyB.body.isValid === true) {
    console.log("    the facilitator verifies ERC-1271: an Altana wallet can pay through it");
  } else {
    console.log(`    the facilitator does NOT accept a smart-account signature: ${verifyB.body.invalidReason ?? "no reason"}`);
    console.log("    Altana wallets then pay through local settlement on this route, not the facilitator");
  }

  // ── 5. Settle, if we have a key. ──
  if (!API_KEY) {
    console.log(`\n[5] POST /settle skipped: set X402_CELO_API_KEY (issued at https://x402.celo.org) to settle for real`);
    const unauth = await post("settle", headerA, requirement);
    console.log(`    without a key it answers ${unauth.status} ${JSON.stringify(unauth.body)}`);
    assert(unauth.status === 401, "/settle refuses an unauthenticated request");
  } else {
    console.log(`\n[5] POST /settle with X402_CELO_API_KEY`);
    const before = await balanceOf(payout.address);
    const settled = await post("settle", headerA, requirement);
    console.log(`    ${settled.status} ${JSON.stringify(settled.body)}`);
    assert(settled.body.success === true, `the facilitator settled (${JSON.stringify(settled.body)})`);
    const txHash = settled.body.transaction as Hex;
    assert(/^0x[0-9a-fA-F]{64}$/.test(txHash), "it returned a transaction hash");
    console.log(`    tx ${network.explorer}/tx/${txHash}`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const after = await balanceOf(payout.address);
    assert(after - before === PRICE, `the payout received ${usdc(PRICE)} (before ${usdc(before)}, after ${usdc(after)})`);
    console.log(`    payout received ${usdc(after - before)}, gas paid by the facilitator`);

    // Return it to the funder so nothing is stranded. The payout EOA has no
    // CELO, so this needs a gas top-up first.
    await returnToFunder(payout, funder.address, funderWallet, after);
  }

  console.log("\n==================================================");
  console.log("Result: PASS");
}

/** An EIP-3009 authorization signed by an EOA, in the x402 v2 envelope. */
async function eoaPayment(account: ReturnType<typeof privateKeyToAccount>, req: X402Requirement) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: req.payTo as Address,
    value: String(req.amount ?? req.maxAmountRequired),
    validAfter: String(now - 60),
    validBefore: String(now + (req.maxTimeoutSeconds ?? 300)),
    nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex,
  };
  const signature = await account.signTypedData(
    buildEip3009TypedData({
      chainId: CELO_SEPOLIA.chainId,
      token: USDC_CELO_SEPOLIA.address,
      name: USDC_CELO_SEPOLIA.name,
      version: USDC_CELO_SEPOLIA.version,
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    }) as never,
  );
  const envelope = {
    x402Version: 2,
    scheme: "exact",
    network: req.network,
    accepted: req,
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

/**
 * The same authorization signed by an Altana smart account through a session
 * key, which is an ERC-1271 signature rather than a 65-byte ecrecover one.
 */
async function smartAccountPayment(req: X402Requirement, funderWallet: ReturnType<typeof createWalletClient>) {
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer: admin });
  saveThrowawayKey(wallet.address, adminKey);

  // Fund it with CELO for the grant, and with the USDC it is about to authorize.
  const celoTx = await funderWallet.sendTransaction({ to: wallet.address, value: parseUnits("0.3", 18), account: funderWallet.account!, chain: network.chain });
  await publicClient.waitForTransactionReceipt({ hash: celoTx });
  await waitForBalance(publicClient, wallet.address, parseUnits("0.3", 18), 120_000);
  const usdcTx = await funderWallet.sendTransaction({
    to: USDC_CELO_SEPOLIA.address,
    data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [wallet.address, PRICE * 2n] }),
    account: funderWallet.account!,
    chain: network.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: usdcTx });

  const session = await client.grantSession({
    wallet,
    signer: admin,
    register: false,
    permissions: {
      calls: [{ to: USDC_CELO_SEPOLIA.address }],
      spend: [{ limit: parseUnits("0.2", 18), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  if (session.status !== "granted") {
    throw new Error(`grantSession failed: ${JSON.stringify(session.legs, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  const { header } = await signX402Payment(session, req);
  return { header, wallet: wallet.address };
}

/** Sends the payout's USDC back to the funder; it needs a CELO top-up first. */
async function returnToFunder(
  payout: ReturnType<typeof privateKeyToAccount>,
  funder: Address,
  funderWallet: ReturnType<typeof createWalletClient>,
  amount: bigint,
) {
  console.log("\n[sweep] return the payout's USDC to the funder");
  try {
    const gas = parseUnits("0.05", 18);
    const top = await funderWallet.sendTransaction({ to: payout.address, value: gas, account: funderWallet.account!, chain: network.chain });
    await publicClient.waitForTransactionReceipt({ hash: top });
    await waitForBalance(publicClient, payout.address, gas, 120_000);
    const payoutWallet = createWalletClient({ account: payout, chain: network.chain, transport: http(network.publicRpcUrl) });
    const tx = await payoutWallet.sendTransaction({
      to: USDC_CELO_SEPOLIA.address,
      data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [funder, amount] }),
      account: payout,
      chain: network.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log(`    returned ${usdc(amount)} (${tx})`);
  } catch (err) {
    console.log(`    sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

function appendKey(comment: string, name: string, key: Hex) {
  const file = testnetEnvFile();
  appendFileSync(file, `\n# ${comment}, ${new Date().toISOString()}\n${name}=${key}\n`);
}

function savePayoutKey(address: Address, key: Hex) {
  appendKey(`live-x402-celo-facilitator payout ${address}`, `X402_CELO_PAYOUT_${address.slice(2, 10).toUpperCase()}_KEY`, key);
}

function saveThrowawayKey(address: Address, key: Hex) {
  appendKey(`live-x402-celo-facilitator smart-account admin ${address}`, `X402_CELO_${address.slice(2, 10).toUpperCase()}_KEY`, key);
  console.log("    throwaway key saved to the shared testnet env file");
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
