/**
 * FORK E2E: native-coin receive limits of a 7702-delegated wallet, against the
 * REAL BSC-mainnet account proxy bytecode (issue #55).
 *
 * An Altana wallet is an EOA delegated (EIP-7702) to the relay's account
 * proxy. Executing that proxy costs more than the 2300-gas stipend a Solidity
 * `.transfer()` / `.send()` forwards — a cold SLOAD of the wallet's ERC-1967
 * slot (2100) plus the cold DELEGATECALL to the implementation (2600) already
 * exceeds it. So any contract that pays out native coin with the stipend
 * reverts when the recipient is an Altana wallet, with empty revert data.
 * This is a property of the *paying* contract; nothing wallet- or SDK-side
 * can add gas to someone else's `.transfer()`.
 *
 * What this pins, all against genuine mainnet bytecode:
 *
 *   1. A payer contract that sends with the stipend (exactly what
 *      `.transfer()` compiles to: `call` with gas 0 + the 2300 stipend for
 *      nonzero value) reverts paying a delegated wallet, and succeeds paying
 *      a plain EOA.
 *   2. The same payout with a full-gas `call{value:}` succeeds — the wallet
 *      itself receives native coin fine when given real gas. That is the
 *      control proving the wallet works and the stipend is the only variable.
 *   3. The reported real-world case: Venus core-pool vBNB. `mint{value:}`
 *      from the delegated wallet lands, `redeem` of the same position hard
 *      reverts (vBNB's `doTransferOut` is `to.transfer(amount)`), and the
 *      identical redeem succeeds the moment the wallet's code is stripped
 *      back to a plain EOA — balance delta checked, since CToken soft
 *      failures return error codes with a `success` receipt.
 *
 * If this test ever flips, the documented limitation in docs/pages/sdk/
 * errors.mdx no longer holds (Venus gateway deployed, delegate redesigned,
 * or stipend semantics changed) — update the docs with it.
 *
 * Run: bun run fork:native-receive   (needs `anvil`)
 */
import {
  concatHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  padHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// `||`, not `??`: an unset GitHub Actions secret arrives as an empty string,
// which would be handed to `anvil --fork-url` verbatim.
const RPC = process.env.BSC_FORK_RPC_URL || "https://bsc-rpc.publicnode.com";
const ANVIL_PORT = 8553;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

/** Venus core-pool vBNB — the CEther-style market from the report. */
const VBNB: Address = "0xA07c5b74C9B40447a954e1466938b865b6BBea36";

/**
 * What an Altana wallet's code actually is on mainnet: the EIP-7702
 * delegation to the relay's account proxy. Read live from the relay so a
 * rotated deployment cannot make this test quietly pin the wrong bytecode;
 * the pinned value is the fallback when the relay is unreachable.
 */
const MAINNET_ACCOUNT_PROXY: Address = "0xc0F16888F4198f53892C53Af859f673e23F26fa3";

async function accountProxyAddress(): Promise<{ address: Address; source: string }> {
  try {
    const res = await fetch("https://relay.altana.network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getCapabilities", params: [["0x38"]] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json();
    const address = body?.result?.["0x38"]?.contracts?.accountProxy?.address;
    if (typeof address === "string") return { address: address as Address, source: "mainnet relay" };
  } catch {
    // Fall through to the pinned value.
  }
  return { address: MAINNET_ACCOUNT_PROXY, source: "pinned fallback" };
}

/**
 * Minimal payer runtime: send the contract's whole balance to CALLER exactly
 * the way `.transfer()` does — `call` with gas 0, so the callee gets only the
 * 2300 stipend the EVM adds for nonzero value — and revert if that fails.
 *
 *   PUSH1 0 ×4 (ret/args) SELFBALANCE CALLER PUSH1 0 (gas) CALL
 *   PUSH1 0x15 JUMPI  PUSH1 0 PUSH1 0 REVERT  JUMPDEST STOP
 */
const STIPEND_PAYER: Hex = "0x600060006000600047336000f160155760006000fd5b00";
/** Same payout with all remaining gas (`call{value:}(\"\")`) — GAS not PUSH1 0. */
const FULLGAS_PAYER: Hex = "0x600060006000600047335af160145760006000fd5b00";

const VBNB_ABI = [
  { name: "mint", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
  { name: "redeem", type: "function", stateMutability: "nonpayable", inputs: [{ name: "redeemTokens", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const test = createTestClient({ mode: "anvil", chain: bsc, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bsc, transport: http(ANVIL_URL) });

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try { await publicClient.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil not ready");
}

/** Send from `from` with explicit gas (skips estimation so reverts land as mined receipts). */
async function sendAs(from: Address, tx: { to: Address; data?: Hex; value?: bigint }) {
  const wallet = createWalletClient({ account: from, chain: bsc, transport: http(ANVIL_URL) });
  const hash = await wallet.sendTransaction({ ...tx, gas: 2_000_000n });
  return publicClient.waitForTransactionReceipt({ hash });
}

/** A funded fresh address; delegated to `proxy` when given, else a plain EOA. */
async function freshAccount(proxy?: Address): Promise<Address> {
  const addr = privateKeyToAccount(generatePrivateKey()).address;
  await test.setBalance({ address: addr, value: 10n * 10n ** 18n });
  if (proxy) await test.setCode({ address: addr, bytecode: concatHex(["0xef0100", proxy]) });
  await test.impersonateAccount({ address: addr });
  return addr;
}

const vTokenBalance = (owner: Address) =>
  publicClient.readContract({ address: VBNB, abi: VBNB_ABI, functionName: "balanceOf", args: [owner] });

/**
 * Fallback if Venus governance has paused core-pool BNB minting on the forked
 * block: write the wallet's vBNB balance straight into the CToken's
 * `accountTokens` mapping, probing the first 50 slots for the one `balanceOf`
 * reads (the dealToken pattern from fork-x402.ts).
 */
async function dealVTokens(owner: Address, amount: bigint): Promise<boolean> {
  for (let slot = 0; slot < 50; slot++) {
    const mapSlot = keccak256(concatHex([padHex(owner, { size: 32 }), padHex(toHex(slot), { size: 32 })]));
    const before = await publicClient.getStorageAt({ address: VBNB, slot: mapSlot });
    await test.setStorageAt({ address: VBNB, index: mapSlot, value: padHex(toHex(amount), { size: 32 }) });
    if ((await vTokenBalance(owner)) === amount) return true;
    await test.setStorageAt({ address: VBNB, index: mapSlot, value: before ?? padHex("0x0", { size: 32 }) });
  }
  return false;
}

async function main() {
  console.log(`▶ Booting anvil BSC-mainnet fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", RPC, "--port", String(ANVIL_PORT), "--hardfork", "prague"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitForAnvil();

    const proxy = await accountProxyAddress();
    const proxyCode = await publicClient.getCode({ address: proxy.address });
    assert(!!proxyCode && proxyCode !== "0x", `account proxy ${proxy.address} has code on the fork`);
    console.log(`  account proxy ${proxy.address} (${proxy.source})`);

    // ── 1+2: the isolated mechanism, real proxy, synthetic payer ──────────
    const wallet = await freshAccount(proxy.address);
    const eoa = await freshAccount();
    const stipendPayer = privateKeyToAccount(generatePrivateKey()).address;
    const fullgasPayer = privateKeyToAccount(generatePrivateKey()).address;
    await test.setCode({ address: stipendPayer, bytecode: STIPEND_PAYER });
    await test.setCode({ address: fullgasPayer, bytecode: FULLGAS_PAYER });
    await test.setBalance({ address: stipendPayer, value: 10n ** 18n });
    await test.setBalance({ address: fullgasPayer, value: 10n ** 18n });

    console.log("▶ Stipend payout (what .transfer() compiles to) ...");
    const toWallet = await sendAs(wallet, { to: stipendPayer });
    assert(toWallet.status === "reverted", "stipend payout to the delegated wallet reverts");
    const toEoa = await sendAs(eoa, { to: stipendPayer });
    assert(toEoa.status === "success", "the same stipend payout to a plain EOA succeeds");
    console.log("  ✓ reverts for the delegated wallet, succeeds for a plain EOA");

    console.log("▶ Full-gas payout (call{value:}) to the same wallet ...");
    const balBefore = await publicClient.getBalance({ address: wallet });
    const fullGas = await sendAs(wallet, { to: fullgasPayer });
    assert(fullGas.status === "success", "full-gas payout to the delegated wallet succeeds");
    assert((await publicClient.getBalance({ address: wallet })) > balBefore, "wallet balance increased");
    console.log("  ✓ the wallet receives fine when the payer forwards real gas");

    // ── 3: the reported case — Venus core-pool vBNB ───────────────────────
    console.log("▶ Venus vBNB: mint 1 BNB from the delegated wallet ...");
    const mint = await sendAs(wallet, {
      to: VBNB,
      data: encodeFunctionData({ abi: VBNB_ABI, functionName: "mint" }),
      value: 10n ** 18n,
    }).catch(() => null);
    let vBal = await vTokenBalance(wallet);
    if (!mint || mint.status !== "success" || vBal === 0n) {
      console.log("  mint unavailable on this block (paused?) — dealing vTokens via storage");
      assert(await dealVTokens(wallet, 10n ** 8n), "dealt vBNB balance into accountTokens");
      vBal = await vTokenBalance(wallet);
    }
    assert(vBal > 0n, "delegated wallet holds vBNB");
    console.log(`  ✓ position open (${vBal} vBNB)`);

    console.log("▶ vBNB redeem to the delegated wallet (the reported failure) ...");
    const redeemData = encodeFunctionData({ abi: VBNB_ABI, functionName: "redeem", args: [vBal] });
    const redeem = await sendAs(wallet, { to: VBNB, data: redeemData });
    assert(redeem.status === "reverted", "redeem reverts while the wallet is delegated (doTransferOut .transfer)");
    console.log("  ✓ hard revert, exactly as reported in #55");

    console.log("▶ Same redeem after stripping the delegation (plain-EOA control) ...");
    await test.setCode({ address: wallet, bytecode: "0x" });
    const nativeBefore = await publicClient.getBalance({ address: wallet });
    const redeemPlain = await sendAs(wallet, { to: VBNB, data: redeemData });
    assert(redeemPlain.status === "success", "redeem succeeds once the wallet is a plain EOA");
    // Balance delta, not the receipt: CToken soft failures return error codes
    // with a `success` receipt, so only the payout itself proves the redeem.
    assert((await publicClient.getBalance({ address: wallet })) > nativeBefore, "BNB actually paid out");
    console.log("  ✓ identical call pays out to a plain EOA — the delegation is the only variable");

    console.log(
      "\nResult: PASS ✓ — 2300-gas-stipend native payouts cannot reach a 7702-delegated wallet; full-gas payouts can.",
    );
  } finally {
    anvil.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
