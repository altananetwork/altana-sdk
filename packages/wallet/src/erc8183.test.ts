import { describe, expect, test } from "bun:test";
import { toFunctionSelector } from "viem";
import { buildHireCalls, buildClaimRefundCall, erc8183Addresses, ERC8183_ADDRESSES } from "./erc8183.js";

const A = erc8183Addresses(97);

const HIRE = {
  addresses: A,
  jobId: 42n,
  provider: "0x00000000000000000000000000000000000000a1" as const,
  description: "Audit my Venus position",
  budget: 20n * 10n ** 18n,
  expiredAt: 1_900_000_000n,
};

describe("buildHireCalls", () => {
  test("emits the five buyer calls in kernel order with the right targets and selectors", () => {
    const calls = buildHireCalls(HIRE);
    const sel = (sig: string) => toFunctionSelector(sig);
    expect(calls.map((c) => c.to)).toEqual([A.commerce, A.router, A.commerce, A.paymentToken, A.commerce]);
    expect(calls.map((c) => c.data!.slice(0, 10))).toEqual([
      sel("createJob(address,address,uint256,string,address)"),
      sel("registerJob(uint256,address)"),
      sel("setBudget(uint256,uint256,bytes)"),
      sel("approve(address,uint256)"),
      sel("fund(uint256,uint256,bytes)"),
    ]);
  });

  test("binds the router as both evaluator and hook", () => {
    const [createJob] = buildHireCalls(HIRE);
    // evaluator (2nd arg) and hook (5th arg) both = router
    expect(createJob!.data!.toLowerCase().split(A.router.slice(2).toLowerCase()).length - 1).toBe(2);
  });

  test("refuses descriptions over the kernel's 4096-byte cap", () => {
    expect(() => buildHireCalls({ ...HIRE, description: "x".repeat(4097) })).toThrow(/4096/);
  });

  test("claimRefund call targets the kernel", () => {
    const call = buildClaimRefundCall(97, 7n);
    expect(call.to).toBe(A.commerce);
    expect(call.data!.startsWith(toFunctionSelector("claimRefund(uint256)"))).toBe(true);
  });

  test("address registry covers both BNB networks and rejects others", () => {
    expect(ERC8183_ADDRESSES[56]!.paymentToken).toBe("0xcE24439F2D9C6a2289F741120FE202248B666666");
    expect(ERC8183_ADDRESSES[97]!.paymentToken).toBe("0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565");
    // Policies must stay whitelisted on each chain's EvaluatorRouter, or every
    // hire reverts with PolicyNotWhitelisted() at registerJob (issue #53).
    expect(ERC8183_ADDRESSES[56]!.policy).toBe("0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5");
    expect(ERC8183_ADDRESSES[97]!.policy).toBe("0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA");
    expect(() => erc8183Addresses(1)).toThrow(/chainId 1/);
  });

  test("registerJob is called with the registry's policy", () => {
    const [, registerJob] = buildHireCalls(HIRE);
    expect(registerJob!.data!.toLowerCase()).toContain(A.policy.slice(2).toLowerCase());
  });
});
