import { describe, expect, test, vi } from "vitest";
import { keccak256 } from "viem";
import { runCrossChain, type CrossChainDeps, type StepState } from "../../src/lib/crossChain";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const PUB = "0x04aabb" as const;

function deps(over: Partial<CrossChainDeps> = {}): CrossChainDeps {
  let polls = 0;
  return {
    readFee: vi.fn(async () => 207099407163124n),
    isValidKey: vi.fn(async () => polls > 0),
    sourceBalance: vi.fn(async () => 10n ** 18n),
    prepare: vi.fn(async () => ({ multiChainRoot: "0xroot" as const, quoteChainIds: [11142220, 11155111], escrowed: 2800072018104900n, sourceFeeMax: 5n, raw: {} })),
    sign: vi.fn(async () => "0xsig" as const),
    send: vi.fn(async () => "0xbundle"),
    status: vi.fn(async () => {
      polls++;
      return polls < 2 ? { status: 100, receipts: [] } : { status: 200, receipts: [{ chainId: 11142220, transactionHash: "0xa" as const }, { chainId: 11155111, transactionHash: "0xb" as const }] };
    }),
    sleep: async () => undefined,
    now: () => 0,
    ...over,
  };
}

describe("runCrossChain", () => {
  test("walks every step and returns the verified result", async () => {
    const steps: StepState[] = [];
    const r = await runCrossChain(deps(), { wallet: WALLET, publicKey: PUB, onStep: (s) => steps.push(s) });
    expect(r.keyId).toBe(keccak256(PUB));
    expect(r.receipts).toHaveLength(2);
    expect(r.valid).toBe(true);
    expect(r.escrowed).toBe(2800072018104900n);
    expect(steps.filter((s) => s.state === "done").map((s) => s.step)).toEqual(["fee", "balance", "prepare", "sign", "send", "wait", "verify"]);
  });

  test("stops when the key is already registered", async () => {
    const d = deps({ isValidKey: vi.fn(async () => true) });
    await expect(runCrossChain(d, { wallet: WALLET, publicKey: PUB, onStep: () => undefined })).rejects.toThrow(/already registered/);
    expect(d.prepare).not.toHaveBeenCalled();
  });

  test("fails on a single quote or a failed bundle", async () => {
    await expect(
      runCrossChain(deps({ prepare: vi.fn(async () => ({ quoteChainIds: [11155111], escrowed: 0n, sourceFeeMax: 0n, raw: {} })) }), { wallet: WALLET, publicKey: PUB, onStep: () => undefined }),
    ).rejects.toThrow(/two|Sepolia quote/i);
    const steps: StepState[] = [];
    await expect(
      runCrossChain(deps({ status: vi.fn(async () => ({ status: 500, receipts: [] })) }), { wallet: WALLET, publicKey: PUB, onStep: (s) => steps.push(s) }),
    ).rejects.toThrow(/status 500/);
    expect(steps.filter((s) => s.step === "wait").at(-1)?.state).toBe("failed");
  });

  test("times out when the bundle never completes", async () => {
    let t = 0;
    const d = deps({ status: vi.fn(async () => ({ status: 100, receipts: [] })), now: () => (t += 100_000) });
    await expect(runCrossChain(d, { wallet: WALLET, publicKey: PUB, onStep: () => undefined, timeoutMs: 250_000 })).rejects.toThrow(/Timed out/);
  });
});
