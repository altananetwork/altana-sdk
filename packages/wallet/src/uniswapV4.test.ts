/**
 * Uniswap v4 liquidity:
 *  - the address table and pool identity
 *  - every call builder, decoded back through an independent restatement of
 *    the PositionManager ABI and v4-periphery's per-action parameter layouts
 *  - the single-selector session permission
 *  - PositionInfo unpacking and tokenId recovery from a receipt
 *
 * No relay stub: `./execute.js` is owned by erc8004.test.ts (one mock owner
 * per specifier — see that file's header), and every path here that reaches
 * the relay is covered by the BNB Chain fork e2e instead.
 */
import { test, expect, describe } from "bun:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  maxUint160,
  pad,
  toEventSelector,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import {
  UNISWAP_V4_ADDRESSES,
  NATIVE_CURRENCY,
  V4_ACTIONS,
  uniswapV4Addresses,
  uniswapV4LiquidityPermissions,
  sortCurrencies,
  poolId,
  encodeUnlockData,
  buildMintPositionCall,
  buildIncreaseLiquidityCall,
  buildDecreaseLiquidityCall,
  buildCollectFeesCall,
  buildBurnPositionCall,
  buildPermit2ApproveCall,
  decodePositionInfo,
  findMintedTokenId,
  mintUniswapV4Position,
  type PoolKey,
} from "./uniswapV4.js";
import { PERMIT2_ADDRESS } from "./x402.js";
import { BNB } from "./config.js";
import type { Session } from "./internal/sessions.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955" as Address;

/** The live BNB/USDT 0.05% pool on BNB Chain. */
const BNB_USDT: PoolKey = {
  currency0: NATIVE_CURRENCY,
  currency1: USDT_BSC,
  fee: 500,
  tickSpacing: 10,
  hooks: NATIVE_CURRENCY,
};

// Independent restatement of what we decode against.
const MODIFY_ABI = [
  {
    name: "modifyLiquidities",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/** Decode a builder's call into `(actions, params)`, asserting it targets the PositionManager. */
function program(call: { to: Address; data?: Hex }, chainId = 56) {
  expect(call.to).toBe(uniswapV4Addresses(chainId).positionManager);
  const { functionName, args } = decodeFunctionData({ abi: MODIFY_ABI, data: call.data! });
  expect(functionName).toBe("modifyLiquidities");
  const [unlockData, deadline] = args;
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], unlockData);
  const actionList = [...Buffer.from(actions.slice(2), "hex")];
  return { actionList, params, deadline };
}

describe("addresses and pools", () => {
  test("the three mainnets, with the canonical Permit2", () => {
    for (const id of [1, 56, 8453]) {
      const a = uniswapV4Addresses(id);
      expect(a.permit2).toBe(PERMIT2_ADDRESS);
      expect(a.positionManager).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(uniswapV4Addresses(56).positionManager).toBe("0x7a4a5c919ae2541aed11041a1aeee68f1287f95b");
    expect(Object.keys(UNISWAP_V4_ADDRESSES).sort()).toEqual(["1", "56", "8453"]);
  });

  test("no deployment on BSC testnet", () => {
    expect(() => uniswapV4Addresses(97)).toThrow(/chainId 97/);
  });

  test("currencies sort by address, native first", () => {
    expect(sortCurrencies(USDT_BSC, NATIVE_CURRENCY)).toEqual([NATIVE_CURRENCY, USDT_BSC]);
    expect(sortCurrencies(OTHER, WALLET)).toEqual([WALLET, OTHER]);
  });

  test("poolId is keccak256(abi.encode(key))", () => {
    const expected = keccak256(encodeAbiParameters([POOL_KEY], [BNB_USDT]));
    expect(poolId(BNB_USDT)).toBe(expected);
  });
});

describe("permissions", () => {
  test("exactly modifyLiquidities on the PositionManager", () => {
    const perms = uniswapV4LiquidityPermissions(56);
    expect(perms).toHaveLength(1);
    expect(perms[0]).toEqual({
      to: uniswapV4Addresses(56).positionManager,
      signature: "modifyLiquidities(bytes,uint256)",
    });
    expect(toFunctionSelector(perms[0]!.signature)).toBe("0xdd46508f");
    // ...which is the selector the builders emit.
    const call = buildMintPositionCall({
      chainId: 56, poolKey: BNB_USDT, tickLower: -60000, tickUpper: -59000,
      liquidity: 1n, amount0Max: 1n, amount1Max: 0n, owner: WALLET,
    });
    expect(call.data!.slice(0, 10)).toBe("0xdd46508f");
  });
});

describe("encodeUnlockData", () => {
  test("one byte per action, one blob per action", () => {
    const data = encodeUnlockData([0x02, 0x0d], ["0xaa", "0xbb"]);
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], data);
    expect(actions).toBe("0x020d");
    expect(params).toEqual(["0xaa", "0xbb"]);
  });
  test("refuses mismatched lengths", () => {
    expect(() => encodeUnlockData([0x02], [])).toThrow(/1 action/);
  });
});

describe("mint", () => {
  const input = {
    chainId: 56,
    poolKey: BNB_USDT,
    tickLower: -60000,
    tickUpper: -59000,
    liquidity: 123456789n,
    amount0Max: 5n * 10n ** 17n,
    amount1Max: 0n,
    owner: WALLET,
    deadline: 1_900_000_000n,
  };

  test("MINT_POSITION, SETTLE_PAIR, SWEEP, SWEEP with the pool, range and owner", () => {
    const call = buildMintPositionCall(input);
    const { actionList, params, deadline } = program(call);
    expect(actionList).toEqual([V4_ACTIONS.MINT_POSITION, V4_ACTIONS.SETTLE_PAIR, V4_ACTIONS.SWEEP, V4_ACTIONS.SWEEP]);
    expect(deadline).toBe(1_900_000_000n);

    const [key, tickLower, tickUpper, liquidity, a0, a1, owner, hookData] = decodeAbiParameters(
      [POOL_KEY, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
      params[0]!,
    );
    expect(key).toEqual(BNB_USDT);
    expect([tickLower, tickUpper]).toEqual([-60000, -59000]);
    expect(liquidity).toBe(123456789n);
    expect([a0, a1]).toEqual([input.amount0Max, 0n]);
    expect(owner).toBe(WALLET);
    expect(hookData).toBe("0x");

    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }], params[1]!)).toEqual([NATIVE_CURRENCY, USDT_BSC]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }], params[2]!)).toEqual([NATIVE_CURRENCY, WALLET]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }], params[3]!)).toEqual([USDT_BSC, WALLET]);
  });

  test("native currency0 rides as value; an ERC-20 pair sends none", () => {
    expect(buildMintPositionCall(input).value).toBe(input.amount0Max);
    const erc20Pair: PoolKey = { ...BNB_USDT, currency0: WALLET, currency1: USDT_BSC };
    expect(buildMintPositionCall({ ...input, poolKey: erc20Pair }).value).toBe(0n);
  });

  test("hookData passes through", () => {
    const { params } = program(buildMintPositionCall({ ...input, hookData: "0xdeadbeef" }));
    const decoded = decodeAbiParameters(
      [POOL_KEY, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
      params[0]!,
    );
    expect(decoded[7]).toBe("0xdeadbeef");
  });

  test("defaults the deadline to about 20 minutes out", () => {
    const { deadline } = program(buildMintPositionCall({ ...input, deadline: undefined }));
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(deadline >= now + 19n * 60n && deadline <= now + 21n * 60n).toBe(true);
  });

  test("rejects an inverted or misaligned range", () => {
    expect(() => buildMintPositionCall({ ...input, tickLower: -59000, tickUpper: -60000 })).toThrow(/below/);
    expect(() => buildMintPositionCall({ ...input, tickLower: -60005 })).toThrow(/tickSpacing 10/);
  });
});

describe("increase / decrease / collect / burn", () => {
  test("INCREASE_LIQUIDITY settles and sweeps to the wallet, with native value", () => {
    const call = buildIncreaseLiquidityCall({
      chainId: 56, poolKey: BNB_USDT, tokenId: 42n, liquidity: 7n,
      amount0Max: 10n ** 17n, amount1Max: 0n, wallet: WALLET, deadline: 1n,
    });
    const { actionList, params } = program(call);
    expect(actionList).toEqual([V4_ACTIONS.INCREASE_LIQUIDITY, V4_ACTIONS.SETTLE_PAIR, V4_ACTIONS.SWEEP, V4_ACTIONS.SWEEP]);
    expect(call.value).toBe(10n ** 17n);
    const [tokenId, liquidity, a0, a1] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0]!,
    );
    expect([tokenId, liquidity, a0, a1]).toEqual([42n, 7n, 10n ** 17n, 0n]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }], params[3]!)).toEqual([USDT_BSC, WALLET]);
  });

  test("DECREASE_LIQUIDITY takes the pair to the recipient", () => {
    const call = buildDecreaseLiquidityCall({
      chainId: 56, poolKey: BNB_USDT, tokenId: 42n, liquidity: 5n,
      amount0Min: 1n, amount1Min: 2n, recipient: OTHER, deadline: 1n,
    });
    const { actionList, params } = program(call);
    expect(actionList).toEqual([V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR]);
    expect(call.value).toBe(0n);
    const [tokenId, liquidity, a0, a1] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0]!,
    );
    expect([tokenId, liquidity, a0, a1]).toEqual([42n, 5n, 1n, 2n]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], params[1]!))
      .toEqual([NATIVE_CURRENCY, USDT_BSC, OTHER]);
  });

  test("collect is a zero-liquidity decrease", () => {
    const { actionList, params } = program(
      buildCollectFeesCall({ chainId: 56, poolKey: BNB_USDT, tokenId: 42n, recipient: WALLET, deadline: 1n }),
    );
    expect(actionList).toEqual([V4_ACTIONS.DECREASE_LIQUIDITY, V4_ACTIONS.TAKE_PAIR]);
    const [, liquidity, a0, a1] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0]!,
    );
    expect([liquidity, a0, a1]).toEqual([0n, 0n, 0n]);
  });

  test("BURN_POSITION takes the pair to the recipient", () => {
    const { actionList, params } = program(
      buildBurnPositionCall({ chainId: 56, poolKey: BNB_USDT, tokenId: 42n, amount0Min: 3n, amount1Min: 4n, recipient: WALLET, deadline: 1n }),
    );
    expect(actionList).toEqual([V4_ACTIONS.BURN_POSITION, V4_ACTIONS.TAKE_PAIR]);
    const [tokenId, a0, a1, hookData] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0]!,
    );
    expect([tokenId, a0, a1, hookData]).toEqual([42n, 3n, 4n, "0x"]);
    expect(decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], params[1]!))
      .toEqual([NATIVE_CURRENCY, USDT_BSC, WALLET]);
  });
});

describe("Permit2 approval", () => {
  test("approve(token, positionManager, max, forever) on Permit2", () => {
    const call = buildPermit2ApproveCall({ chainId: 56, token: USDT_BSC });
    expect(call.to).toBe(PERMIT2_ADDRESS);
    expect(call.data!.slice(0, 10)).toBe("0x87517c45");
    const [token, spender, amount, expiration] = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }],
      `0x${call.data!.slice(10)}`,
    );
    expect(token).toBe(USDT_BSC);
    // viem checksums decoded addresses; the table stores Uniswap's lowercase form.
    expect(spender.toLowerCase()).toBe(uniswapV4Addresses(56).positionManager.toLowerCase());
    expect(amount).toBe(maxUint160);
    expect(expiration).toBe(2 ** 48 - 1);
  });
});

describe("reads", () => {
  test("decodePositionInfo unpacks negative ticks and the subscriber flag", () => {
    const twos = (t: number) => BigInt(t < 0 ? t + 0x1000000 : t);
    const info = (0xabcn << 56n) | (twos(-59000) << 32n) | (twos(-60000) << 8n) | 1n;
    expect(decodePositionInfo(info)).toEqual({ tickLower: -60000, tickUpper: -59000, hasSubscriber: true });
    expect(decodePositionInfo((twos(200) << 32n) | (twos(100) << 8n))).toEqual({ tickLower: 100, tickUpper: 200, hasSubscriber: false });
  });

  test("findMintedTokenId wants the PositionManager's Transfer from 0x0 to the owner", () => {
    const pm = uniswapV4Addresses(56).positionManager;
    const transfer = toEventSelector("Transfer(address,address,uint256)");
    const zero = pad("0x0", { size: 32 });
    const owner = pad(WALLET, { size: 32 });
    const id = pad("0x2a", { size: 32 });
    const logs = [
      { address: OTHER, topics: [transfer, zero, owner, id], data: "0x" }, // another contract
      { address: pm, topics: [transfer, owner, pad(OTHER, { size: 32 }), id], data: "0x" }, // not a mint
      { address: pm, topics: [transfer, zero, pad(OTHER, { size: 32 }), id], data: "0x" }, // someone else's
      { address: pm, topics: [transfer, zero, owner, id], data: "0x" },
    ] as never;
    expect(findMintedTokenId(logs, pm, WALLET)).toBe(42n);
    expect(findMintedTokenId(logs.slice(0, 3), pm, WALLET)).toBeUndefined();
  });
});

describe("mintUniswapV4Position", () => {
  test("refuses noWait: the tokenId comes from the receipt", async () => {
    const session = { walletAddress: WALLET, publicKey: "0x", permissions: {}, expiry: 0, signer: {} } as unknown as Session;
    await expect(
      mintUniswapV4Position(
        session,
        { poolKey: BNB_USDT, tickLower: -60000, tickUpper: -59000, liquidity: 1n, amount0Max: 1n, amount1Max: 0n },
        { network: BNB, noWait: true },
      ),
    ).rejects.toThrow(/noWait/);
  });
});
