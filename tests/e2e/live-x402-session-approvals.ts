/**
 * LIVE (Celo Sepolia) — the two approvals an x402 payment needs from a session
 * key, proven from a wallet that starts with neither.
 *
 * Three parts, in the order they matter:
 *
 *   A. A session granted the ordinary way has neither approval.
 *      `checkX402Approvals` says so and names both, and `fetchWithX402` refuses
 *      to pay rather than settling into a revert. This is the failure qa hit,
 *      turned into a message that names the cause.
 *   B. A session granted with `x402Tokens` has both, set in the **same intent**
 *      that authorized it, which is one transaction and no follow-ups. Read
 *      back on chain: `approvedSignatureCheckers` and the ERC-20 allowance.
 *   C. That second session pays a real x402 request, settled over Permit2.
 *
 * Part A is the point. Without the check, the same wallet reaches settlement
 * and the merchant answers `settlement failed: Execution reverted for an
 * unknown reason`, which names neither approval.
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO on Celo Sepolia (>= 1) and a little USDC
 *   X402_SELLER_URL        a running seller, default http://127.0.0.1:4021/paid
 *                          (`bun run serve:x402-celo` in this directory)
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *
 * Run: bun run live:x402-approvals   (from tests/e2e)
 */
import {
  checkX402Approvals,
  createClient,
  fetchWithX402,
  signerFromPrivateKey,
  waitForBalance,
  CELO_SEPOLIA,
  PERMIT2_ADDRESS,
  type NetworkConfig,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const SELLER = process.env.X402_SELLER_URL ?? "http://127.0.0.1:4021/paid";
const PRICE = parseUnits("0.01", 6);
const CELO_FUNDING = parseEther("0.5");
const USDC_FUNDING = parseUnits("0.05", 6);

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};
const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const CHECKERS_ABI = [
  { name: "approvedSignatureCheckers", type: "function", stateMutability: "view", inputs: [{ name: "keyHash", type: "bytes32" }], outputs: [{ type: "address[]" }] },
] as const;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const usdc = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;

const allowance = (owner: Address) =>
  pub.readContract({ address: USDC, abi: ERC20, functionName: "allowance", args: [owner, PERMIT2_ADDRESS] }) as Promise<bigint>;
const checkers = (wallet: Address, keyHash: Hex) =>
  pub.readContract({ address: wallet, abi: CHECKERS_ABI, functionName: "approvedSignatureCheckers", args: [keyHash] }).catch(() => []) as Promise<readonly Address[]>;

async function main() {
  console.log("LIVE x402 session approvals on Celo Sepolia");
  console.log("===========================================\n");

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });
  const funderUsdc = (await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [funder.address] })) as bigint;
  console.log(`funder ${funder.address}: ${usdc(funderUsdc)}`);
  assert(funderUsdc >= USDC_FUNDING * 2n, `the funder holds at least ${usdc(USDC_FUNDING * 2n)}`);

  const client = createClient({ chains: [network] });
  const expiry = () => Math.floor(Date.now() / 1000) + 3600;
  const permissions = { calls: [{ to: USDC }], spend: [{ limit: parseUnits("0.2", 6), period: "day" as const }] };

  // ── A fresh wallet with neither approval. ──
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  appendFileSync(
    testnetEnvFile(),
    `\n# live-x402-session-approvals wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `X402APPROVALS_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
  );
  console.log(`\nwallet ${wallet.address} (key saved before funding)`);

  const celoTx = await fw.sendTransaction({ to: wallet.address, value: CELO_FUNDING, account: funder, chain: celoSepolia });
  await pub.waitForTransactionReceipt({ hash: celoTx });
  await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
  const usdcTx = await fw.sendTransaction({
    to: USDC,
    data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [wallet.address, USDC_FUNDING] }),
    account: funder,
    chain: celoSepolia,
  });
  await pub.waitForTransactionReceipt({ hash: usdcTx });
  console.log(`funded ${formatUnits(CELO_FUNDING, 18)} CELO and ${usdc(USDC_FUNDING)}`);

  const requirement = await sellerRequirement();

  // ── A. The ordinary grant: neither approval, and the SDK says which. ──
  console.log("\n[A] grantSession the ordinary way, then check");
  const plain = await client.grantSession({ wallet, signer: admin, register: false, permissions, expiry: expiry() });
  assert(plain.status === "granted", `the grant succeeded (${plain.status})`);
  const plainSession = plain as unknown as Session;

  const before = await checkX402Approvals(plainSession, requirement, { network });
  console.log(`    ok=${before.ok} checkerApproved=${before.checkerApproved} allowance=${before.permit2Allowance?.actual}`);
  for (const m of before.missing) console.log(`    missing: ${m.split(".")[0]}.`);
  assert(!before.ok, "a session granted the ordinary way has neither approval");
  assert(before.missing.length === 2, `both are reported, not just one (${before.missing.length})`);
  assert((await checkers(wallet.address, before.keyHash)).length === 0, "and the chain agrees: no checkers");

  // fetchWithX402 refuses rather than settling into a revert.
  const refused = await fetchWithX402(plainSession, SELLER).then(
    () => undefined,
    (e: Error) => e.message,
  );
  console.log(`\n    fetchWithX402 refused: ${String(refused).slice(0, 150)}…`);
  assert(refused !== undefined, "fetchWithX402 refuses to pay");
  assert(/approveSignatureChecker|x402Tokens/.test(String(refused)), "and names the fix");

  // ── B. The grant that sets both, in one intent. ──
  console.log("\n[B] grantSession with x402Tokens");
  const ready = await client.grantSession({
    wallet,
    signer: admin,
    register: false,
    permissions,
    expiry: expiry(),
    x402Tokens: [USDC],
  });
  assert(ready.status === "granted", `the grant succeeded (${ready.status})`);
  const readySession = ready as unknown as Session;
  const accountLeg = ready.legs.find((l) => l.kind === "account" && l.chainId === network.chainId);
  console.log(`    one intent: ${network.explorer}/tx/${accountLeg?.transactionHash}`);

  const after = await checkX402Approvals(readySession, requirement, { network });
  console.log(`    ok=${after.ok} checkerApproved=${after.checkerApproved} allowance=${after.permit2Allowance?.actual}`);
  assert(after.ok, `both approvals are in place (${JSON.stringify(after.missing)})`);

  // Read them off chain, not from the SDK's own answer.
  const onChainCheckers = await checkers(wallet.address, after.keyHash);
  console.log(`    approvedSignatureCheckers(${after.keyHash.slice(0, 10)}…) = ${JSON.stringify(onChainCheckers)}`);
  assert(
    onChainCheckers.some((c) => c.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()),
    "Permit2 is an approved checker for the new session key",
  );
  assert(
    onChainCheckers.some((c) => c.toLowerCase() === USDC.toLowerCase()),
    "and so is the token, for the eip3009 rail",
  );
  const allow = await allowance(wallet.address);
  console.log(`    USDC allowance to Permit2 = ${allow}`);
  assert(allow >= PRICE, "the token is approved to Permit2");

  // ── C. And it pays. ──
  console.log("\n[C] fetchWithX402 with the ready session");
  const walletBefore = (await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet.address] })) as bigint;
  const res = await fetchWithX402(readySession, SELLER, undefined, { chainId: network.chainId, preferRail: "permit2" });
  console.log(`    HTTP ${res.status}`);
  assert(res.status === 200, `the seller served the resource (HTTP ${res.status})`);
  for (let i = 0; i < 40; i++) {
    const now = (await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet.address] })) as bigint;
    if (now < walletBefore) {
      console.log(`    wallet paid ${usdc(walletBefore - now)} (${usdc(walletBefore)} -> ${usdc(now)})`);
      assert(walletBefore - now === PRICE, `exactly the quoted price left the wallet`);
      break;
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  await sweep(wallet.address, adminKey, funder.address);

  console.log("\n===========================================");
  console.log("Result: PASS — neither approval is named before paying, x402Tokens sets both in one intent, and the session pays.");
}

/** The seller's own 402 requirement, so the check runs against a real one. */
async function sellerRequirement() {
  const res = await fetch(SELLER).catch((e) => {
    throw new Error(`the seller at ${SELLER} is not answering (${(e as Error).message}). Start it with \`bun run serve:x402-celo\`.`);
  });
  assert(res.status === 402, `the seller answers 402 without payment (got ${res.status})`);
  const body: any = await res.json();
  const req = (Array.isArray(body?.accepts) ? body.accepts : [body]).find(
    (a: any) => a?.extra?.assetTransferMethod === "permit2-exact",
  );
  assert(Boolean(req), "the seller offers the permit2-exact rail");
  console.log(`seller ${SELLER}: ${req.amount ?? req.maxAmountRequired} of ${req.asset}`);
  return { ...req, x402Version: body?.x402Version ?? 2 };
}

/** Returns what is left to the funder. Best effort, logged, never throws. */
async function sweep(wallet: Address, adminKey: Hex, funder: Address) {
  console.log("\n[sweep] return leftover funds to the funder");
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [network] });
  try {
    const left = (await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet] })) as bigint;
    if (left > 0n) {
      const r = await client.execute({
        wallet: { address: wallet },
        signer: admin,
        calls: { to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [funder, left] }), value: 0n },
      });
      console.log(`    returned ${usdc(left)} (${r.status})`);
    }
  } catch (e) {
    console.log(`    USDC sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    const bal = await pub.getBalance({ address: wallet });
    const keep = parseEther("0.1");
    if (bal > keep) {
      const r = await client.execute({ wallet: { address: wallet }, signer: admin, calls: { to: funder, value: bal - keep, data: "0x" } });
      console.log(`    returned ${formatUnits(bal - keep, 18)} CELO (${r.status})`);
    }
  } catch (e) {
    console.log(`    CELO sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
