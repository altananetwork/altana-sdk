/**
 * FORK E2E: Uniswap v4 liquidity against the REAL BNB Chain deployment.
 *
 * Forks BNB Chain (56) — the canonical PositionManager, PoolManager and
 * StateView, and the live BNB/USDT 0.05% pool — and drives what the SDK's
 * builders encode, from an EOA delegated by EIP-7702 to the relay's real
 * account proxy (exactly what an Altana wallet is):
 *
 *   1. The selector-scoped permission gate: authorize a session key exactly
 *      as `grantSession` does with `uniswapV4LiquidityPermissions(56)`, then
 *      ask the account's own `canExecute` what it may do. `modifyLiquidities`
 *      is allowed; every ERC-721 selector on the PositionManager (the LP NFTs
 *      live there) and its unlock-less sibling are refused; the same selector
 *      at the PoolManager is refused; a session scoped elsewhere is refused.
 *   2. The full lifecycle as the wallet: read the pool, size a single-sided
 *      BNB position above the current tick with the SDK's math, mint, read
 *      the position back, increase, collect, decrease, burn — and the BNB
 *      comes home.
 *
 * Single-sided on purpose: a range entirely above the current price holds
 * only currency0 (BNB here), so the fork never has to conjure USDT.
 *
 * Run: bun run fork:uniswap-v4   (needs `anvil`; BSC_FORK_RPC_URL optional)
 */
import {
  concatHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  padHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  NATIVE_CURRENCY,
  buildBurnPositionCall,
  buildCollectFeesCall,
  buildDecreaseLiquidityCall,
  buildIncreaseLiquidityCall,
  buildMintPositionCall,
  createPrivateKeySigner,
  findMintedTokenId,
  getLiquidityForAmounts,
  getSqrtPriceAtTick,
  nearestUsableTick,
  readUniswapV4Pool,
  readUniswapV4Position,
  uniswapV4Addresses,
  uniswapV4LiquidityPermissions,
  type PoolKey,
} from "@altananetwork/sdk";
import { keyHashForSigner } from "../../packages/wallet/src/internal/erc1271.js";

// `||`, not `??`: an unset GitHub Actions secret arrives as an empty string.
const RPC = process.env.BSC_FORK_RPC_URL || "https://bsc-dataseed.binance.org";
const ANVIL_PORT = 8554;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const V4 = uniswapV4Addresses(56);
const USDT: Address = "0x55d398326f99059fF775485246999027B3197955";
/** The live BNB/USDT 0.05% pool: currency0 is native BNB. */
const BNB_USDT: PoolKey = { currency0: NATIVE_CURRENCY, currency1: USDT, fee: 500, tickSpacing: 10, hooks: NATIVE_CURRENCY };

/** Mainnet account proxy every Altana wallet delegates to (same on 1/56/8453). */
const MAINNET_ACCOUNT_PROXY: Address = "0xc0F16888F4198F53892c53AF859f673e23f26fA3";

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

const ACCOUNT_ABI = [
  {
    name: "authorize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{
      name: "key",
      type: "tuple",
      components: [
        { name: "expiry", type: "uint40" },
        { name: "keyType", type: "uint8" },
        { name: "isSuperAdmin", type: "bool" },
        { name: "publicKey", type: "bytes" },
      ],
    }],
    outputs: [{ name: "keyHash", type: "bytes32" }],
  },
  {
    name: "setCanExecute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "fnSel", type: "bytes4" },
      { name: "can", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    // ERC-7821 batch execution — how the account runs calls.
    name: "execute",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "mode", type: "bytes32" },
      { name: "executionData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC721_ABI = [
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

/** ERC-7821 mode: single batch, revert on failure, no opData. */
const BATCH_MODE: Hex = "0x0100000000000000000000000000000000000000000000000000000000000000";
/** KeyType enum: P256=0, WebAuthnP256=1, Secp256k1=2, External=3. */
const KEY_TYPE_SECP256K1 = 2;

const test = createTestClient({ mode: "anvil", chain: bsc, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bsc, transport: http(ANVIL_URL) });
const network = { chain: bsc, chainId: 56, publicRpcUrl: ANVIL_URL } as never;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try { await publicClient.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil not ready");
}

/** An EOA delegated to the account proxy: a real Altana wallet, minus the relay. */
async function delegatedWallet(proxy: Address): Promise<Address> {
  const account = privateKeyToAccount(generatePrivateKey()).address;
  await test.setBalance({ address: account, value: 100n * 10n ** 18n });
  await test.setCode({ address: account, bytecode: concatHex(["0xef0100", proxy]) });
  await test.impersonateAccount({ address: account });
  return account;
}

/** Send a call from the account to itself (satisfies `onlyThis`). */
async function selfCall(account: Address, data: Hex) {
  const asAccount = createWalletClient({ account, chain: bsc, transport: http(ANVIL_URL) });
  const hash = await asAccount.sendTransaction({ to: account, data, gas: 3_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success", `account self-call reverted (${data.slice(0, 10)})`);
  return receipt;
}

/** Run calls AS the wallet through its own ERC-7821 `execute` (the admin path). */
async function executeAsWallet(account: Address, calls: readonly { to: Address; value?: bigint; data?: Hex }[]) {
  const executionData = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
    [calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data ?? "0x" }))],
  );
  return selfCall(account, encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execute", args: [BATCH_MODE, executionData] }));
}

/** Authorize a session key exactly as a grant does; returns its keyHash. */
async function authorizeSessionKey(
  account: Address,
  sessionSigner: ReturnType<typeof createPrivateKeySigner>,
  permissions: readonly { to?: Address; signature?: string }[],
): Promise<Hex> {
  await selfCall(account, encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: "authorize",
    args: [{ expiry: 0, keyType: KEY_TYPE_SECP256K1, isSuperAdmin: false, publicKey: padHex(sessionSigner.address, { size: 32 }) }],
  }));
  const keyHash = keyHashForSigner(sessionSigner);
  for (const p of permissions) {
    assert(!!p.to && !!p.signature, "every granted permission must name a target AND a selector");
    const selector = p.signature!.startsWith("0x") ? (p.signature as Hex) : toFunctionSelector(p.signature!);
    await selfCall(account, encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "setCanExecute", args: [keyHash, p.to!, selector, true] }));
  }
  return keyHash;
}

function canExecute(account: Address, keyHash: Hex, target: Address, data: Hex) {
  return publicClient.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "canExecute", args: [keyHash, target, data] });
}

// ── 1. The permission gate ──────────────────────────────────────────────────

async function checkPermissionGate(proxy: Address) {
  const account = await delegatedWallet(proxy);
  const scoped = createPrivateKeySigner();
  const scopedHash = await authorizeSessionKey(account, scoped, uniswapV4LiquidityPermissions(56) as never);

  const mint = buildMintPositionCall({
    chainId: 56, poolKey: BNB_USDT, tickLower: -60000, tickUpper: -59000,
    liquidity: 1n, amount0Max: 1n, amount1Max: 0n, owner: account,
  });
  assert(await canExecute(account, scopedHash, V4.positionManager, mint.data!), "scoped session may call modifyLiquidities");
  console.log("  ✓ modifyLiquidities is allowed");

  // Everything a `{ to: positionManager }` catch-all would ALSO authorize.
  const forbidden = [
    "transferFrom(address,address,uint256)",
    "safeTransferFrom(address,address,uint256)",
    "approve(address,uint256)",
    "setApprovalForAll(address,bool)",
    "permit(address,uint256,uint256,uint256,bytes)",
    "multicall(bytes[])",
    "subscribe(uint256,address,bytes)",
    "modifyLiquiditiesWithoutUnlock(bytes,bytes[])",
  ];
  for (const sig of forbidden) {
    assert(!(await canExecute(account, scopedHash, V4.positionManager, toFunctionSelector(sig))), `scoped session must NOT be able to call ${sig}`);
  }
  console.log(`  ✓ all ${forbidden.length} other PositionManager selectors are refused`);

  assert(!(await canExecute(account, scopedHash, V4.poolManager, mint.data!)), "the selector must not be callable at another contract");
  console.log("  ✓ the same selector at the PoolManager is refused");

  const elsewhere = createPrivateKeySigner();
  const elsewhereHash = await authorizeSessionKey(account, elsewhere, [{ to: USDT, signature: "transfer(address,uint256)" }]);
  assert(!(await canExecute(account, elsewhereHash, V4.positionManager, mint.data!)), "a session without the liquidity permission must NOT reach the PositionManager");
  console.log("  ✓ a session granted elsewhere cannot touch liquidity");

  await test.stopImpersonatingAccount({ address: account });
}

// ── 2. The lifecycle ────────────────────────────────────────────────────────

async function ownerOf(tokenId: bigint): Promise<Address | undefined> {
  try {
    return await publicClient.readContract({ address: V4.positionManager, abi: ERC721_ABI, functionName: "ownerOf", args: [tokenId] });
  } catch {
    return undefined; // burned
  }
}

async function runLifecycle(proxy: Address) {
  const account = await delegatedWallet(proxy);
  const startBalance = await publicClient.getBalance({ address: account });

  const pool = await readUniswapV4Pool(network, BNB_USDT);
  assert(pool.liquidity > 0n, "the BNB/USDT 500 pool has liquidity on this fork");
  console.log(`  · pool tick ${pool.tick}, sqrtPriceX96 ${pool.sqrtPriceX96}, liquidity ${pool.liquidity}`);

  // A range strictly above the current tick holds only BNB (currency0).
  const tickLower = nearestUsableTick(pool.tick + 100, BNB_USDT.tickSpacing);
  const tickUpper = tickLower + 50 * BNB_USDT.tickSpacing;
  assert(tickLower > pool.tick, "range sits above the current tick");
  const deposit = 5n * 10n ** 17n; // 0.5 BNB
  const liquidity = getLiquidityForAmounts(pool.sqrtPriceX96, getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), deposit, 0n);
  assert(liquidity > 0n, "sized a non-zero position");

  // Mint.
  const mintReceipt = await executeAsWallet(account, [
    buildMintPositionCall({ chainId: 56, poolKey: BNB_USDT, tickLower, tickUpper, liquidity, amount0Max: deposit, amount1Max: 0n, owner: account }),
  ]);
  const tokenId = findMintedTokenId(mintReceipt.logs as never, V4.positionManager, account);
  assert(tokenId !== undefined, "the mint's Transfer(0 → wallet) names a tokenId");
  const minted = await readUniswapV4Position(network, tokenId!);
  assert(minted.owner.toLowerCase() === account.toLowerCase(), "the wallet owns the LP NFT");
  assert(minted.tickLower === tickLower && minted.tickUpper === tickUpper, "the range round-trips");
  assert(minted.liquidity === liquidity, `liquidity round-trips (${minted.liquidity} vs ${liquidity})`);
  assert(minted.poolKey.currency1.toLowerCase() === USDT.toLowerCase() && minted.poolKey.fee === 500, "the pool key round-trips");
  const afterMint = await publicClient.getBalance({ address: account });
  assert(startBalance - afterMint >= deposit * 99n / 100n, "the mint took (about) the deposit");
  assert(startBalance - afterMint <= deposit + 10n ** 16n, "the mint took no more than the deposit plus gas — excess was swept back");
  console.log(`  ✓ minted position #${tokenId} (${liquidity} liquidity) for ~${Number(startBalance - afterMint) / 1e18} BNB`);

  // Increase.
  const more = liquidity / 2n;
  await executeAsWallet(account, [
    buildIncreaseLiquidityCall({ chainId: 56, poolKey: BNB_USDT, tokenId: tokenId!, liquidity: more, amount0Max: deposit, amount1Max: 0n, wallet: account }),
  ]);
  const increased = await readUniswapV4Position(network, tokenId!);
  assert(increased.liquidity === liquidity + more, "increase added exactly the requested liquidity");
  console.log(`  ✓ increased to ${increased.liquidity}`);

  // Collect (no swaps happened, so nothing to collect — but the call must succeed).
  await executeAsWallet(account, [buildCollectFeesCall({ chainId: 56, poolKey: BNB_USDT, tokenId: tokenId!, recipient: account })]);
  assert((await readUniswapV4Position(network, tokenId!)).liquidity === liquidity + more, "collect leaves principal untouched");
  console.log("  ✓ collected fees (zero) without touching principal");

  // Decrease half.
  const beforeDecrease = await publicClient.getBalance({ address: account });
  await executeAsWallet(account, [
    buildDecreaseLiquidityCall({ chainId: 56, poolKey: BNB_USDT, tokenId: tokenId!, liquidity: more, amount0Min: 0n, amount1Min: 0n, recipient: account }),
  ]);
  const decreased = await readUniswapV4Position(network, tokenId!);
  assert(decreased.liquidity === liquidity, "decrease removed exactly the requested liquidity");
  const afterDecrease = await publicClient.getBalance({ address: account });
  assert(afterDecrease > beforeDecrease, "the withdrawn BNB came back to the wallet");
  console.log(`  ✓ decreased to ${decreased.liquidity}; ${Number(afterDecrease - beforeDecrease) / 1e18} BNB returned`);

  // Burn.
  await executeAsWallet(account, [
    buildBurnPositionCall({ chainId: 56, poolKey: BNB_USDT, tokenId: tokenId!, amount0Min: 0n, amount1Min: 0n, recipient: account }),
  ]);
  assert((await ownerOf(tokenId!)) === undefined, "the LP NFT is burned");
  const endBalance = await publicClient.getBalance({ address: account });
  // Everything came home, less gas and the pool's rounding on the way in and out.
  assert(startBalance - endBalance < 10n ** 16n, `the wallet is whole again (net ${Number(startBalance - endBalance) / 1e18} BNB)`);
  console.log(`  ✓ burned; net cost of the round trip ${Number(startBalance - endBalance) / 1e18} BNB (gas + rounding)`);

  await test.stopImpersonatingAccount({ address: account });
}

async function main() {
  console.log(`\n▶ Booting anvil BNB Chain fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", RPC, "--port", String(ANVIL_PORT), "--silent"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitForAnvil();

    const proxy = await accountProxyAddress();
    const proxyCode = await publicClient.getCode({ address: proxy.address });
    assert(!!proxyCode && proxyCode !== "0x", `the account proxy ${proxy.address} (${proxy.source}) is deployed on this fork`);
    console.log(`  · wallets delegate to ${proxy.address} (${proxy.source})`);

    console.log("▶ permission gate: what a session scoped by uniswapV4LiquidityPermissions may do ...");
    await checkPermissionGate(proxy.address);

    console.log("▶ lifecycle: mint → increase → collect → decrease → burn on the live BNB/USDT pool ...");
    await runLifecycle(proxy.address);

    console.log("\nResult: PASS ✓ — Uniswap v4 liquidity against real PositionManager bytecode.\n");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
