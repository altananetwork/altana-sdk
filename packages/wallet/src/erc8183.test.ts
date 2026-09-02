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

// ============================== seller side ==================================

import {
  buildSubmitCall,
  encodeErc8183Manifest,
  erc8183ManifestHash,
  erc8183SubmitPermissions,
  submitErc8183Deliverable,
  verifyErc8183ManifestText,
  type Erc8183DeliverableManifest,
} from "./erc8183.js";
import { decodeFunctionData, keccak256, toHex } from "viem";

const SUBMIT_ABI = [
  {
    name: "submit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "deliverable", type: "bytes32" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const MANIFEST: Erc8183DeliverableManifest = {
  version: 1,
  job_id: 42,
  chain_id: 97,
  contracts: { commerce: A.commerce, router: A.router, policy: A.policy },
  // em-dash, accented Latin, a BMP symbol, CJK, and an astral emoji — the
  // exact classes of content whose escaping diverges between Python's
  // ensure_ascii and a naive JSON.stringify (issue #59's cross-language trap).
  response: { content: "Position healthy — no action needed. Café ☕ 汉字 😀", content_type: "text/plain" },
  metadata: {},
};

// Generated live from:
//   python3 -c 'import json; print(json.dumps(<MANIFEST>, sort_keys=True, separators=(",", ":")))'
const PYTHON_CANONICAL =
  '{"chain_id":97,"contracts":{"commerce":"0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE","policy":"0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA","router":"0xD7d36D66d2F1B608A0F943f722D27e3744f66F25"},"job_id":42,"metadata":{},"response":{"content":"Position healthy \\u2014 no action needed. Caf\\u00e9 \\u2615 \\u6c49\\u5b57 \\ud83d\\ude00","content_type":"text/plain"},"version":1}';

describe("seller path", () => {
  test("buildSubmitCall targets the kernel and round-trips its args", () => {
    const deliverable = keccak256(toHex("x"));
    const call = buildSubmitCall({ addresses: A, jobId: 7n, deliverable, optParams: toHex('{"deliverable_url":"https://x"}') });
    expect(call.to).toBe(A.commerce);
    const { functionName, args } = decodeFunctionData({ abi: SUBMIT_ABI, data: call.data! });
    expect(functionName).toBe("submit");
    expect(args).toEqual([7n, deliverable, toHex('{"deliverable_url":"https://x"}')]);
  });

  test("optParams defaults to empty bytes", () => {
    const call = buildSubmitCall({ addresses: A, jobId: 7n, deliverable: keccak256(toHex("x")) });
    const { args } = decodeFunctionData({ abi: SUBMIT_ABI, data: call.data! });
    expect(args[2]).toBe("0x");
  });

  test("the canonical manifest is byte-identical to Python's json.dumps (incl. surrogate pairs)", () => {
    expect(encodeErc8183Manifest(MANIFEST)).toBe(PYTHON_CANONICAL);
  });

  test("manifest hash and raw-text verification agree, and reject tampering", () => {
    const text = encodeErc8183Manifest(MANIFEST);
    const hash = erc8183ManifestHash(MANIFEST);
    expect(keccak256(toHex(text))).toBe(hash);
    expect(verifyErc8183ManifestText(text, hash)).toBe(true);
    expect(verifyErc8183ManifestText(text + " ", hash)).toBe(false);
    // A re-serialized (non-canonical) copy of the same document must fail:
    // the chain committed to exact bytes.
    expect(verifyErc8183ManifestText(JSON.stringify(MANIFEST), hash)).toBe(false);
  });

  test("submit permission is scoped to exactly the submit selector on commerce", () => {
    const perms = erc8183SubmitPermissions(97);
    expect(perms).toHaveLength(1);
    expect(perms[0]!.to).toBe(A.commerce);
    const call = buildSubmitCall({ addresses: A, jobId: 1n, deliverable: keccak256(toHex("x")) });
    expect(toFunctionSelector(perms[0]!.signature)).toBe(call.data!.slice(0, 10));
    // Never a to-only catch-all: the session must not reach fund/claimRefund.
    expect(perms.every((p) => p.signature)).toBe(true);
  });

  test("submitErc8183Deliverable enforces the manifest/deliverable XOR before any I/O", async () => {
    const session = { walletAddress: "0x00000000000000000000000000000000000000a1", publicKey: "0x04", permissions: {}, expiry: 0, signer: {} } as never;
    const opts = { network: null as never };
    await expect(
      submitErc8183Deliverable(session, { jobId: 1n } as never, opts as never),
    ).rejects.toThrow(/exactly one of/);
    await expect(
      submitErc8183Deliverable(
        session,
        { jobId: 1n, manifest: MANIFEST, deliverableUrl: "https://x", deliverable: keccak256(toHex("x")) } as never,
        opts as never,
      ),
    ).rejects.toThrow(/exactly one of/);
  });

  test("submitErc8183Deliverable rejects manifest/job mismatches before any I/O", async () => {
    const session = { walletAddress: "0x00000000000000000000000000000000000000a1", publicKey: "0x04", permissions: {}, expiry: 0, signer: {} } as never;
    const netOpts = { network: { chainId: 97 } as never };
    await expect(
      submitErc8183Deliverable(session, { jobId: 43n, manifest: MANIFEST, deliverableUrl: "https://x" }, netOpts as never),
    ).rejects.toThrow(/job_id/);
    await expect(
      submitErc8183Deliverable(
        session,
        { jobId: 42n, manifest: { ...MANIFEST, chain_id: 56 }, deliverableUrl: "https://x" },
        netOpts as never,
      ),
    ).rejects.toThrow(/chain_id/);
  });
});

// ===================== deliverable optParams decode ==========================

import { decodeDeliverableOptParams } from "./erc8183.js";
import { toHex as toHexViem } from "viem";

describe("decodeDeliverableOptParams", () => {
  test("decodes the conventional payload (runtime-neutral — no Buffer)", () => {
    const url = "https://seller.example/manifests/1.json";
    expect(decodeDeliverableOptParams(toHexViem(JSON.stringify({ deliverable_url: url })))).toBe(url);
  });

  test("strips trailing NUL padding and survives non-ASCII URLs", () => {
    const url = "https://seller.example/ü—😀.json";
    const padded = (toHexViem(JSON.stringify({ deliverable_url: url })) + "000000") as `0x${string}`;
    expect(decodeDeliverableOptParams(padded)).toBe(url);
  });

  test("returns undefined for empty, malformed, or url-less payloads", () => {
    expect(decodeDeliverableOptParams(undefined)).toBeUndefined();
    expect(decodeDeliverableOptParams("0x")).toBeUndefined();
    expect(decodeDeliverableOptParams(toHexViem("not json"))).toBeUndefined();
    expect(decodeDeliverableOptParams(toHexViem(JSON.stringify({ deliverable_url: 42 })))).toBeUndefined();
    expect(decodeDeliverableOptParams("0xfffe")).toBeUndefined();
  });
});
