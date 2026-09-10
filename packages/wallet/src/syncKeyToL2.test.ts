/**
 * The proof building blocks behind ensureKeyCached / syncSessionToCache:
 *  - computeKeyPackedSlot mirrors KeyStoreCacheOPStack.keyPackedSlot;
 *  - buildPopulateKeyCall encodes populateKey over the anchored L1 header
 *    (RLP round-trips a real Sepolia Prague header, requestsHash included)
 *    and the proofs fetched at that block, and maps the "proof window"
 *    refusal of shallow RPCs to a message that names the fix;
 *  - waitForL1Anchor resolves once the L2 anchors past the target block and
 *    times out with the documented message.
 * Fake clients throughout; no network I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import sepoliaBlock from "./internal/fixtures/sepolia-block-11668265.json" with { type: "json" };
import {
  buildPopulateKeyCall,
  computeKeyPackedSlot,
  readL1Anchor,
  waitForL1Anchor,
} from "./syncKeyToL2.js";

const L1_KEYSTORE: Address = "0x38Aaf396F462Ad3a4F38ADa653AF6bDEA55F772d";
const CACHE: Address = "0x37ebf8F17c3705568a03fB3A1629AcE7B3D95FFf";
const USER: Address = "0xD035abdb79eDb8F868319F8B3FB3a2fb51032cB8";
const PUBKEY: Hex =
  "0x8e8329b69d0b91226d88d3ba6b764a4f6387bd66ac4d967801368e899237f4a96c7aec5e3c15eb3286a1f5651d6d3e24f2bfdb30ffceebdf9225fe9ac73b5219";
const ZERO_HASH: Hex = ("0x" + "00".repeat(32)) as Hex;

const POPULATE_ABI = [
  {
    name: "populateKey",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "publicKey", type: "bytes" },
      { name: "blockHeader", type: "bytes" },
      { name: "accountProof", type: "bytes[]" },
      { name: "keyStorageProof", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

/** viem-shaped block: bigint numeric fields, as getBlock returns. */
function fixtureBlock() {
  const b = sepoliaBlock as Record<string, string | null>;
  const big = (k: string) => (b[k] == null ? undefined : BigInt(b[k] as string));
  return {
    ...b,
    number: big("number"),
    difficulty: big("difficulty"),
    gasLimit: big("gasLimit"),
    gasUsed: big("gasUsed"),
    timestamp: big("timestamp"),
    baseFeePerGas: big("baseFeePerGas"),
    blobGasUsed: big("blobGasUsed"),
    excessBlobGas: big("excessBlobGas"),
  };
}

const BLOCK = fixtureBlock();
const BLOCK_HASH = BLOCK.hash as Hex;
const BLOCK_NUMBER = BLOCK.number as bigint;

function l2ClientAnchoring(hash: Hex, number: bigint): PublicClient {
  return {
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "hash" ? hash : number,
  } as unknown as PublicClient;
}

describe("computeKeyPackedSlot", () => {
  test("mirrors keccak(keyId . keccak(user . 3)) + 3", () => {
    const keyId = keccak256(PUBKEY);
    const inner = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [USER, 3n]),
    );
    const base = BigInt(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keyId, inner])),
    );
    const expected = ("0x" + (base + 3n).toString(16).padStart(64, "0")) as Hex;
    expect(computeKeyPackedSlot(USER, keyId)).toBe(expected);
    // Pinned so a layout change in the KeyStore (slot 3, offset 3) is caught here first.
    expect(computeKeyPackedSlot(USER, keyId)).toBe(
      "0x48184b3741a42951fae58a18fb2fab14d7bf632756e6e03fbd0c226fb0267f75",
    );
  });
});

describe("readL1Anchor", () => {
  test("returns hash and number from the predeploy", async () => {
    const anchor = await readL1Anchor(l2ClientAnchoring(BLOCK_HASH, BLOCK_NUMBER));
    expect(anchor).toEqual({ hash: BLOCK_HASH, number: BLOCK_NUMBER });
  });

  test("throws when the chain is not anchored yet", async () => {
    await expect(readL1Anchor(l2ClientAnchoring(ZERO_HASH, 0n))).rejects.toThrow(
      /reports zero hash/,
    );
  });
});

describe("buildPopulateKeyCall", () => {
  const accountProof: Hex[] = ["0xf90211aa", "0xf8669d3e"];
  const storageProof: Hex[] = ["0xf90211bb", "0xf39f305d"];
  let proofRequest: { address: Address; storageKeys: Hex[]; blockNumber: bigint } | undefined;

  const l1Client = {
    getBlock: async ({ blockHash }: { blockHash: Hex }) => {
      if (blockHash.toLowerCase() !== BLOCK_HASH.toLowerCase()) throw new Error("unknown block");
      return BLOCK;
    },
    getProof: async (req: { address: Address; storageKeys: Hex[]; blockNumber: bigint }) => {
      proofRequest = req;
      return { accountProof, storageProof: [{ key: req.storageKeys[0], value: 1n, proof: storageProof }] };
    },
  } as unknown as PublicClient;

  test("encodes populateKey over the anchored header and the proofs at that block", async () => {
    const call = await buildPopulateKeyCall({
      l1Client,
      l2Client: l2ClientAnchoring(BLOCK_HASH, BLOCK_NUMBER),
      l1KeyStore: L1_KEYSTORE,
      l2Cache: CACHE,
      user: USER,
      publicKey: PUBKEY,
    });
    expect(call.to).toBe(CACHE);
    expect(call.value).toBe(0n);
    expect(call.l1BlockNumber).toBe(BLOCK_NUMBER);
    expect(call.l1BlockHash).toBe(BLOCK_HASH);

    // The proof was requested for the packed slot at the anchored block.
    expect(proofRequest?.address).toBe(L1_KEYSTORE);
    expect(proofRequest?.blockNumber).toBe(BLOCK_NUMBER);
    expect(proofRequest?.storageKeys).toEqual([computeKeyPackedSlot(USER, keccak256(PUBKEY))]);

    const decoded = decodeFunctionData({ abi: POPULATE_ABI, data: call.data });
    expect(decoded.functionName).toBe("populateKey");
    const [user, publicKey, header, ap, sp] = decoded.args;
    expect(user).toBe(USER);
    expect(publicKey).toBe(PUBKEY);
    // The RLP header must hash to the anchored block hash, or the cache
    // rejects it ("block header mismatch"). Prague header: requestsHash included.
    expect(keccak256(header)).toBe(BLOCK_HASH);
    expect(sepoliaBlock.requestsHash).toBeDefined();
    expect(ap).toEqual(accountProof);
    expect(sp).toEqual(storageProof);
  });

  test("uses a supplied anchor without re-reading the predeploy", async () => {
    const neverRead = {
      readContract: async () => {
        throw new Error("should not read the predeploy");
      },
    } as unknown as PublicClient;
    const call = await buildPopulateKeyCall({
      l1Client,
      l2Client: neverRead,
      l1KeyStore: L1_KEYSTORE,
      l2Cache: CACHE,
      user: USER,
      publicKey: PUBKEY,
      anchor: { hash: BLOCK_HASH, number: BLOCK_NUMBER },
    });
    expect(call.l1BlockNumber).toBe(BLOCK_NUMBER);
  });

  test("a shallow RPC's proof-window refusal becomes a message naming the fix", async () => {
    const shallow = {
      getBlock: async () => BLOCK,
      getProof: async () => {
        throw new Error("distance to target block exceeds maximum proof window");
      },
    } as unknown as PublicClient;
    await expect(
      buildPopulateKeyCall({
        l1Client: shallow,
        l2Client: l2ClientAnchoring(BLOCK_HASH, BLOCK_NUMBER),
        l1KeyStore: L1_KEYSTORE,
        l2Cache: CACHE,
        user: USER,
        publicKey: PUBKEY,
      }),
    ).rejects.toThrow(/proof window that covers the anchor/);
  });
});

describe("waitForL1Anchor", () => {
  test("resolves once the anchored block reaches the target", async () => {
    let reads = 0;
    const l2Client = {
      readContract: async () => {
        reads++;
        return reads < 3 ? ZERO_HASH : BLOCK_HASH;
      },
    } as unknown as PublicClient;
    const l1Client = {
      getBlock: async () => ({ number: BLOCK_NUMBER, hash: BLOCK_HASH }),
    } as unknown as PublicClient;
    const anchor = await waitForL1Anchor({
      l1Client,
      l2Client,
      targetL1Block: BLOCK_NUMBER,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(anchor).toEqual({ hash: BLOCK_HASH, number: BLOCK_NUMBER });
    expect(reads).toBe(3);
  });

  test("keeps waiting while the anchor is older than the target", async () => {
    let calls = 0;
    const l2Client = { readContract: async () => BLOCK_HASH } as unknown as PublicClient;
    const l1Client = {
      getBlock: async () => ({ number: BLOCK_NUMBER - (calls++ < 2 ? 5n : 0n), hash: BLOCK_HASH }),
    } as unknown as PublicClient;
    const anchor = await waitForL1Anchor({
      l1Client,
      l2Client,
      targetL1Block: BLOCK_NUMBER,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(anchor.number).toBe(BLOCK_NUMBER);
    expect(calls).toBe(3);
  });

  test("times out with the documented message, under the caller's label", async () => {
    const l2Client = { readContract: async () => BLOCK_HASH } as unknown as PublicClient;
    const l1Client = {
      getBlock: async () => ({ number: BLOCK_NUMBER - 1n, hash: BLOCK_HASH }),
    } as unknown as PublicClient;
    await expect(
      waitForL1Anchor({
        l1Client,
        l2Client,
        targetL1Block: BLOCK_NUMBER,
        pollIntervalMs: 1,
        timeoutMs: 10,
        label: "ensureKeyCached",
      }),
    ).rejects.toThrow(
      `ensureKeyCached: L2 did not anchor past L1 block ${BLOCK_NUMBER} within 10ms`,
    );
  });
});
