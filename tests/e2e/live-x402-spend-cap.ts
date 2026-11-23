/**
 * LIVE (Celo Sepolia): a session's spend cap applied to x402 payments, which
 * the SDK checks before it signs (issue #164).
 *
 * The account enforces a spend cap inside `execute`. An x402 payment is a
 * signature somebody else settles, so the account is never shown its amount.
 * Before the check existed, a session capped at 0.005 USDC a day paid 0.02
 * USDC through x402 in this script (2026-11-23).
 *
 *   A. a session capped at 0.02 USDC a day
 *      1. sends 0.004 USDC with execute            -> confirmed, and the
 *         account's own record (`spendInfos`) shows 0.004 spent
 *      2. sends 0.02 USDC with execute             -> refused by the account,
 *         and the sentence names USDC, not the fee token
 *      3. pays a 0.01 USDC x402 request            -> paid (0.014 of 0.02)
 *      4. pays another 0.01 USDC x402 request      -> refused by the SDK
 *         before signing; nothing leaves the wallet
 *      5. the same with `checkSpendCap: false`     -> paid, which shows the
 *         check is the SDK's and not the account's
 *   B. a session with no cap on USDC pays as it always has
 *   C. a revoked session cannot pay
 *   D. an expired session cannot pay
 *
 * Needs:
 *   TEST_FUNDER_KEY        CELO (>= 12) and USDC (>= 0.1) on Celo Sepolia
 *   X402_SELLER_URL        a running seller, default http://127.0.0.1:4021/paid
 *                          (`bun run serve:x402-celo` in this directory)
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *
 * Run: bun run live:x402-spend-cap   (from tests/e2e)
 */
import {
  checkX402SpendCap,
  createClient,
  signX402Payment,
  fetchWithX402,
  signerFromPrivateKey,
  waitForBalance,
  CELO_SEPOLIA,
  NATIVE_TOKEN,
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
const CAP = parseUnits("0.02", 6);
const UNDER_CAP = parseUnits("0.004", 6);
const CELO_FUNDING = parseEther("10");
const USDC_FUNDING = parseUnits("0.06", 6);
const FEE_CAP = parseEther("5");
/** Which parts to run, for a rerun of one: LIVE_PARTS=CD. Default all. */
const PARTS = (process.env.LIVE_PARTS ?? "ABCD").toUpperCase();

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};
const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`    ok: ${msg}`);
}
const usdc = (raw: bigint) => `${formatUnits(raw, 6)} USDC`;
const balance = (a: Address) => pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const transferCall = (to: Address, amount: bigint) => ({
  to: USDC,
  data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }),
  value: 0n,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How much left the wallet, waiting up to two minutes for a settlement to land. */
async function waitForDrop(wallet: Address, before: bigint): Promise<bigint> {
  for (let i = 0; i < 40; i++) {
    const now = await balance(wallet);
    if (now < before) return before - now;
    await sleep(3_000);
  }
  return 0n;
}

type Thrown = { message: string; code?: string };
const thrown = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: Error) => ({ message: e.message, code: (e as { code?: string }).code }) as Thrown,
  );

async function main() {
  console.log("LIVE x402 spend cap on Celo Sepolia");
  console.log("===================================\n");
  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });
  console.log(`funder holds ${usdc(await balance(funder.address))} and ${formatUnits(await pub.getBalance({ address: funder.address }), 18)} CELO`);
  const probe = await fetch(SELLER).catch(() => undefined);
  if (probe?.status !== 402) throw new Error(`the seller at ${SELLER} is not answering 402. Start it with \`bun run serve:x402-celo\`.`);

  const client = createClient({ chains: [network] });
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const wallet = await client.createWallet({ signer: admin });
  appendFileSync(
    testnetEnvFile(),
    `\n# live-x402-spend-cap wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `X402CAP_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
  );
  console.log(`wallet ${wallet.address} (key saved before funding)`);

  const tx = (hash?: string) => (hash ? `${network.explorer}/tx/${hash}` : "");
  const grant = async (spend: { token?: Address; limit: bigint; period: "day" }[], lifetime = 3600) => {
    const granted = await client.grantSession({
      wallet,
      signer: admin,
      register: false,
      permissions: { calls: [{ to: USDC }], spend },
      feeSpendLimit: FEE_CAP,
      feeToken: NATIVE_TOKEN, // fees in CELO under their own cap, so the USDC cap is only what the agent pays
      expiry: Math.floor(Date.now() / 1000) + lifetime,
      x402Tokens: [USDC],
    });
    if (granted.status !== "granted") throw new Error(`grant failed: ${granted.status}`);
    const leg = granted.legs.find((l) => l.kind === "account" && l.chainId === network.chainId);
    console.log(`    granted: ${tx(leg?.transactionHash)}`);
    return granted as unknown as Session;
  };
  const pay = (session: Session, opts: Record<string, unknown> = {}) =>
    fetchWithX402(session, SELLER, undefined, { chainId: network.chainId, ...opts });

  try {
    const celoTx = await fw.sendTransaction({ to: wallet.address, value: CELO_FUNDING, account: funder, chain: celoSepolia });
    await pub.waitForTransactionReceipt({ hash: celoTx });
    await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
    const usdcTx = await fw.sendTransaction({ ...transferCall(wallet.address, USDC_FUNDING), account: funder, chain: celoSepolia });
    await pub.waitForTransactionReceipt({ hash: usdcTx });
    console.log(`funded ${formatUnits(CELO_FUNDING, 18)} CELO and ${usdc(USDC_FUNDING)}`);

    let before = 0n;
    if (PARTS.includes("A")) {
    // ── A. A session with a USDC cap. ──
    console.log(`\n[A] a session capped at ${usdc(CAP)} a day`);
    const capped = await grant([{ token: USDC, limit: CAP, period: "day" }]);

    console.log(`\n[A1] execute ${usdc(UNDER_CAP)}, under the cap`);
    before = await balance(wallet.address);
    const sent = await client.execute({ session: capped, calls: transferCall(funder.address, UNDER_CAP), feeToken: NATIVE_TOKEN });
    console.log(`    ${sent.status} ${tx(sent.transactionHash)}`);
    assert((await waitForDrop(wallet.address, before)) === UNDER_CAP, `${usdc(UNDER_CAP)} left the wallet`);
    const afterExecute = await checkX402SpendCap(capped, { ...(await sellerRequirement()) }, { network });
    console.log(`    the account's record: ${JSON.stringify(afterExecute.caps, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    assert(afterExecute.caps[0]?.spentOnChain === UNDER_CAP, "the account's own record shows it, and the SDK reads it");

    console.log(`\n[A2] execute ${usdc(CAP)}, over what is left of the cap`);
    before = await balance(wallet.address);
    const overExecute = await thrown(client.execute({ session: capped, calls: transferCall(funder.address, CAP), feeToken: NATIVE_TOKEN }));
    console.log(`    ${overExecute?.code}: ${overExecute?.message}`);
    assert(overExecute?.code === "spend_limit_exceeded", "the account refuses it");
    assert(/in USDC/.test(overExecute?.message ?? "") && !/CELO/.test(overExecute?.message ?? ""), "and the sentence names USDC, not the fee token");
    assert((await balance(wallet.address)) === before, "nothing left the wallet");

    console.log(`\n[A3] x402 payment of ${usdc(PRICE)}, inside the cap`);
    before = await balance(wallet.address);
    const first = await pay(capped, { preferRail: "permit2" });
    console.log(`    HTTP ${first.status} ${(await first.text()).slice(0, 300)}`);
    assert(first.status === 200, "the seller served the resource");
    assert((await waitForDrop(wallet.address, before)) === PRICE, `${usdc(PRICE)} left the wallet`);

    console.log(`\n[A4] a second x402 payment of ${usdc(PRICE)}, which would pass the cap`);
    before = await balance(wallet.address);
    for (const rail of ["permit2", "eip3009"] as const) {
      const refused = await thrown(pay(capped, { preferRail: rail }));
      console.log(`    ${rail}: ${refused?.code}: ${refused?.message}`);
      assert(refused?.code === "spend_limit_exceeded", `the SDK refuses it on the ${rail} rail, before signing`);
    }
    await sleep(15_000);
    assert((await balance(wallet.address)) === before, "nothing left the wallet");

    console.log(`\n[A5] the same payment with the check switched off`);
    before = await balance(wallet.address);
    const unchecked = await pay(capped, { preferRail: "eip3009", checkSpendCap: false });
    console.log(`    HTTP ${unchecked.status}`);
    assert(unchecked.status === 200, "it is paid: the account itself does not bound an x402 payment");
    assert((await waitForDrop(wallet.address, before)) === PRICE, `${usdc(PRICE)} left the wallet`);

    }
    if (PARTS.includes("B")) {
    // ── B. No cap on the token: nothing changes. ──
    console.log("\n[B] a session with no cap on USDC");
    const uncapped = await grant([]);
    before = await balance(wallet.address);
    const free = await pay(uncapped);
    console.log(`    HTTP ${free.status}`);
    assert(free.status === 200, "it pays as it always has");
    assert((await waitForDrop(wallet.address, before)) === PRICE, `${usdc(PRICE)} left the wallet`);

    }
    if (PARTS.includes("C")) {
    // ── C. A revoked session. ──
    console.log("\n[C] a revoked session");
    const revoked = await grant([]);
    const revoke = await client.revokeSession({ wallet, signer: admin, session: revoked, feeToken: NATIVE_TOKEN });
    console.log(`    revoked: ${tx((revoke as { transactionHash?: string }).transactionHash)}`);
    await cannotPay(revoked, wallet.address, "a revoked session");

    }
    if (PARTS.includes("D")) {
    // ── D. An expired session. ──
    console.log("\n[D] an expired session");
    const LIFETIME = 150;
    const startedAt = Date.now();
    const shortLived = await grant([], LIFETIME);
    const wait = LIFETIME * 1000 - (Date.now() - startedAt) + 20_000;
    console.log(`    waiting ${Math.ceil(wait / 1000)}s for it to expire`);
    await sleep(Math.max(wait, 0));
    await cannotPay(shortLived, wallet.address, "an expired session", "session_expired");
    }
  } finally {
    await sweep(wallet.address, adminKey, funder.address);
  }

  console.log("\n===================================");
  console.log("Result: PASS");
}

/** The seller's own requirement, so a read runs against a real one. */
async function sellerRequirement() {
  const res = await fetch(SELLER);
  const body: any = await res.json();
  const req = (Array.isArray(body?.accepts) ? body.accepts : [body])[0];
  return { ...req, x402Version: body?.x402Version ?? 2 };
}

/**
 * A session the account no longer accepts cannot pay: not through
 * `fetchWithX402`, and not when the payment is signed with the unchecked
 * primitive and sent by hand, where the account refuses the signature at
 * settlement. Nothing moves either way.
 */
async function cannotPay(session: Session, wallet: Address, who: string, expectCode?: string) {
  const before = await balance(wallet);
  // Through fetchWithX402. An expired session is refused by the SDK itself,
  // which holds the expiry. A revoked one is refused by the approval read when
  // the node already shows the revoke, and at settlement when it does not;
  // either way the answer is not the paid resource.
  const guarded = await fetchWithX402(session, SELLER, undefined, { chainId: network.chainId }).then(
    async (r) => ({ refusedBy: "the seller's settlement", code: undefined as string | undefined, text: `HTTP ${r.status} ${(await r.text()).slice(0, 160)}`, paid: r.status === 200 }),
    (e: Error) => ({ refusedBy: "the SDK, before signing", code: (e as { code?: string }).code, text: e.message.slice(0, 160), paid: false }),
  );
  console.log(`    fetchWithX402: refused by ${guarded.refusedBy}: ${guarded.code ?? ""} ${guarded.text}`);
  assert(!guarded.paid, `${who} does not get the paid resource`);
  if (expectCode) assert(guarded.code === expectCode, `the SDK refuses it before signing with ${expectCode}`);


  // Signed with the primitive, which checks nothing, and sent by hand.
  const all = await fetch(SELLER).then((r) => r.json() as Promise<any>);
  const req = all.accepts.find((a: any) => a?.extra?.assetTransferMethod === "eip3009");
  const { header } = await signX402Payment(session, { ...req, x402Version: all.x402Version ?? 2, resource: all.resource });
  const forced = await fetch(SELLER, { headers: { "X-PAYMENT": header, "PAYMENT-SIGNATURE": header } }).then(
    async (r) => `HTTP ${r.status} ${(await r.text()).slice(0, 200)}`,
    (e: Error) => `threw: ${e.message.slice(0, 200)}`,
  );
  console.log(`    with every check off: ${forced}`);
  assert(!forced.startsWith("HTTP 200"), `the seller cannot settle a payment signed by ${who}`);
  await sleep(20_000);
  assert((await balance(wallet)) === before, "nothing left the wallet");
}

async function sweep(wallet: Address, adminKey: Hex, funder: Address) {
  console.log("\n[sweep] return leftover funds to the funder");
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [network] });
  try {
    const left = await balance(wallet);
    if (left > 0n) {
      const r = await client.execute({ wallet: { address: wallet }, signer: admin, calls: transferCall(funder, left), feeToken: NATIVE_TOKEN });
      console.log(`    returned ${usdc(left)} (${r.status})`);
    }
  } catch (e) {
    console.log(`    USDC sweep failed: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    const bal = await pub.getBalance({ address: wallet });
    const keep = parseEther("1");
    if (bal > keep) {
      const r = await client.execute({ wallet: { address: wallet }, signer: admin, calls: { to: funder, value: bal - keep, data: "0x" }, feeToken: NATIVE_TOKEN });
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
