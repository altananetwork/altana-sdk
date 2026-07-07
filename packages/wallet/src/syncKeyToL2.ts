/**
 * Cross-chain session-key sync: prove an L1 KeyStore entry into an L2 cache.
 *
 * The L1 KeyStore on Ethereum is the source of truth for which keys a wallet
 * has authorized. The L2 cache on Base (and future chains) accepts a
 * cryptographic proof that walks from the L1 block hash exposed by the L2's
 * `L1Block` predeploy down to the relevant storage slot. After a successful
 * call, the cache returns `isValidKey(user, keyId) == true` locally and any
 * consumer on the L2 can read it cheaply.
 *
 * The submitter pays L2 gas. The operation is permissionless: anyone may
 * relay a proof on behalf of any user.
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toRlp,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

const L1_BLOCK_PREDEPLOY: Address = "0x4200000000000000000000000000000000000015";

// L1 KeyStore v1.0.0 storage layout:
//   slot 3: mapping(address => mapping(bytes32 => Key)) userKeys
// Within the Key struct, offset 3 is the packed (nonce|lastUpdated|revoked|expiry|isRoot) slot.
const L1_USERKEYS_SLOT = 3n;
const KEY_PACKED_OFFSET = 3n;

const L1_BLOCK_ABI = [
  {
    inputs: [],
    name: "hash",
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const POPULATE_KEY_ABI = [
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

const READ_ABI = [
  {
    name: "getCachedKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "publicKey", type: "bytes" },
          { name: "revoked", type: "bool" },
          { name: "expiry", type: "uint40" },
          { name: "isRoot", type: "bool" },
          { name: "sourceBlockHash", type: "bytes32" },
          { name: "sourceBlockNumber", type: "uint64" },
        ],
      },
    ],
  },
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export type CachedKey = {
  publicKey: Hex;
  revoked: boolean;
  expiry: number;
  isRoot: boolean;
  sourceBlockHash: Hex;
  sourceBlockNumber: bigint;
};

/**
 * Reads the L2 cache entry for (user, keyId). An empty `publicKey` and
 * zeroed fields mean the key has never been proven into this L2 cache.
 */
export function readCachedKey(
  l2Client: PublicClient,
  l2Cache: Address,
  user: Address,
  keyId: Hex,
): Promise<CachedKey> {
  return l2Client.readContract({
    address: l2Cache,
    abi: READ_ABI,
    functionName: "getCachedKey",
    args: [user, keyId],
  }) as Promise<CachedKey>;
}

/**
 * Reads the cache's own `isValidKey(user, keyId)` view. Returns `true` iff the
 * cache has the key, it is not revoked, and its expiry has not passed. Use
 * this as the authoritative check; the `CachedKey` struct is for inspection.
 *
 * Cache v1.1.0 reverts ("call populateKey before isValidKey") when the entry
 * was populated at an older L1 block than the one the L2 currently sees —
 * i.e. the cached data is stale. We map that revert to `false`: the key
 * needs a fresh populateKey proof before it can be considered valid.
 */
export async function isCachedKeyValid(
  l2Client: PublicClient,
  l2Cache: Address,
  user: Address,
  keyId: Hex,
): Promise<boolean> {
  try {
    return (await l2Client.readContract({
      address: l2Cache,
      abi: READ_ABI,
      functionName: "isValidKey",
      args: [user, keyId],
    })) as boolean;
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("call populateKey before isValidKey")
    ) {
      return false;
    }
    throw err;
  }
}

export type SyncKeyToL2Args = {
  /** Public client for the L1 chain (Ethereum) — used for eth_getProof and block lookup. */
  l1Client: PublicClient;
  /** Public client for the L2 chain (e.g. Base) — used for L1Block read + receipt wait. */
  l2Client: PublicClient;
  /** Wallet client on the L2 chain — the relayer that pays L2 gas. */
  l2WalletClient: WalletClient;
  /** L1 KeyStore address whose state is being proven. */
  l1KeyStore: Address;
  /** L2 KeyStoreCache address that will accept the proof. */
  l2Cache: Address;
  /** The user whose key is being synced. Smart account address that registered on L1. */
  user: Address;
  /** Full SEC1-encoded public key bytes (65 bytes for secp256k1/P256 uncompressed). */
  publicKey: Hex;
};

export type SyncKeyToL2Result = {
  txHash: Hex;
  cachedKey: CachedKey;
};

/**
 * Submits a permissionless `populateKey` to the L2 cache proving the key's
 * active state on L1. Resolves after the L2 tx is mined and the cache state
 * has been read back. Single shot — if `keccak(blockHeader) != L1Block.hash()`
 * at inclusion time the tx reverts; callers retry by calling again.
 */
export async function syncKeyToL2(args: SyncKeyToL2Args): Promise<SyncKeyToL2Result> {
  const { l1Client, l2Client, l2WalletClient, l1KeyStore, l2Cache, user, publicKey } = args;

  if (l2WalletClient.account == null) {
    throw new Error("l2WalletClient has no account configured");
  }
  if (l2WalletClient.chain == null) {
    throw new Error("l2WalletClient has no chain configured");
  }

  const keyId = keccak256(publicKey);

  const prepared = await buildPopulateCall({
    l1Client,
    l2Client,
    l1KeyStore,
    user,
    publicKey,
  });

  const data = encodeFunctionData({
    abi: POPULATE_KEY_ABI,
    functionName: "populateKey",
    args: [
      user,
      publicKey,
      prepared.rlpHeader,
      prepared.accountProof,
      prepared.storageProof,
    ],
  });

  const txHash = await l2WalletClient.sendTransaction({
    account: l2WalletClient.account,
    chain: l2WalletClient.chain,
    to: l2Cache,
    data,
  });

  const receipt = await l2Client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`syncKeyToL2: tx reverted (L1Block anchor moved); refresh to retry`);
  }

  const cached = await readCachedKey(l2Client, l2Cache, user, keyId);

  return { txHash, cachedKey: cached };
}

export type EnsureKeyCachedStatus =
  | "cache-hit"
  | "waiting-for-anchor"
  | "submitting-proof"
  | "done";

export type EnsureKeyCachedArgs = SyncKeyToL2Args & {
  /**
   * Progress callback. Fires `cache-hit` immediately if the cache already
   * has the key (and nothing else). Otherwise fires `waiting-for-anchor`
   * → `submitting-proof` → `done`. Use it to drive a UI banner.
   */
  onStatus?: (status: EnsureKeyCachedStatus) => void;
  /**
   * Poll cadence while waiting for the L2's L1Block predeploy to anchor
   * past the L1 block where the key was registered. Default 3s.
   */
  anchorPollIntervalMs?: number;
  /**
   * Max wait for the L1 anchor before giving up. Default 5 minutes.
   * Base typically anchors within 1–3 minutes.
   */
  anchorTimeoutMs?: number;
};

/**
 * Idempotent "sync if needed" wrapper around `syncKeyToL2`. Reads the L2
 * cache first; if the key is already active, returns immediately. Otherwise
 * waits for the L2 to be anchored to a usable L1 block, then submits the
 * proof. Designed to be called from `execute()` on the first L2 action so
 * the developer never thinks about cross-chain proofs.
 */
export async function ensureKeyCached(args: EnsureKeyCachedArgs): Promise<CachedKey> {
  const {
    l1Client,
    l2Client,
    l2Cache,
    user,
    publicKey,
    onStatus,
    anchorPollIntervalMs = 3_000,
    anchorTimeoutMs = 5 * 60_000,
  } = args;

  const keyId = keccak256(publicKey);

  if (await isCachedKeyValid(l2Client, l2Cache, user, keyId)) {
    onStatus?.("cache-hit");
    return readCachedKey(l2Client, l2Cache, user, keyId);
  }

  // We need an L1 block that already contains the registration. Wait until
  // the L2's L1Block predeploy reports a hash that resolves to a block at
  // or past the current L1 tip — anything older risks the storage slot
  // not yet being set in the proven account.
  onStatus?.("waiting-for-anchor");
  const targetL1Block = await l1Client.getBlockNumber();
  const deadline = Date.now() + anchorTimeoutMs;
  while (true) {
    const l1HashOnL2 = (await l2Client.readContract({
      address: L1_BLOCK_PREDEPLOY,
      abi: L1_BLOCK_ABI,
      functionName: "hash",
    })) as Hex;
    if (l1HashOnL2 !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      const anchored = await l1Client.getBlock({ blockHash: l1HashOnL2 });
      if (anchored.number >= targetL1Block) break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `ensureKeyCached: L2 did not anchor past L1 block ${targetL1Block} within ${anchorTimeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, anchorPollIntervalMs));
  }

  onStatus?.("submitting-proof");
  const result = await syncKeyToL2(args);
  onStatus?.("done");
  return result.cachedKey;
}

async function buildPopulateCall(args: {
  l1Client: PublicClient;
  l2Client: PublicClient;
  l1KeyStore: Address;
  user: Address;
  publicKey: Hex;
}): Promise<{ rlpHeader: Hex; accountProof: readonly Hex[]; storageProof: readonly Hex[] }> {
  const { l1Client, l2Client, l1KeyStore, user, publicKey } = args;
  const keyId = keccak256(publicKey);

  const l1HashOnL2 = (await l2Client.readContract({
    address: L1_BLOCK_PREDEPLOY,
    abi: L1_BLOCK_ABI,
    functionName: "hash",
  })) as Hex;
  if (l1HashOnL2 === "0x0000000000000000000000000000000000000000000000000000000000000000") {
    throw new Error("L2 L1Block predeploy reports zero hash — chain not anchored yet");
  }

  const l1Block = await l1Client.getBlock({ blockHash: l1HashOnL2 });
  const packedSlot = computeKeyPackedSlot(user, keyId);

  const proof = await l1Client.getProof({
    address: l1KeyStore,
    storageKeys: [packedSlot],
    blockNumber: l1Block.number,
  });

  const rlpHeader = rlpEncodeHeader(l1Block);
  if (keccak256(rlpHeader).toLowerCase() !== l1Block.hash.toLowerCase()) {
    throw new Error(
      `RLP header encoding does not hash to block hash; block schema likely changed (computed=${keccak256(rlpHeader)}, expected=${l1Block.hash})`,
    );
  }

  return {
    rlpHeader,
    accountProof: proof.accountProof,
    storageProof: proof.storageProof[0]!.proof,
  };
}

/**
 * Storage slot of the packed Key field (offset 3) inside
 * `userKeys[user][keyId]` in the L1 KeyStore v1.0.0. The packed slot holds
 * `(nonce|lastUpdated|revoked|expiry|isRoot)` and is exactly what the L2
 * cache reads to extract revocation / expiry / root status.
 */
function computeKeyPackedSlot(user: Address, keyId: Hex): Hex {
  const innerSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, L1_USERKEYS_SLOT]),
  );
  const structBase = BigInt(
    keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [keyId, innerSlot]),
    ),
  );
  const slot = structBase + KEY_PACKED_OFFSET;
  return `0x${slot.toString(16).padStart(64, "0")}` as Hex;
}

function toHex(input: bigint | number): Hex {
  if (typeof input === "number") input = BigInt(input);
  if (input === 0n) return "0x";
  let hex = input.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return `0x${hex}` as Hex;
}

/**
 * RLP-encodes an Ethereum block header. Field set extends as new EIPs activate
 * (London baseFeePerGas, Shanghai withdrawalsRoot, Cancun blobs+parent beacon,
 * Prague requestsHash). Each is appended only when present on the supplied block.
 */
function rlpEncodeHeader(header: any): Hex {
  const fields: Hex[] = [
    header.parentHash,
    header.sha3Uncles,
    header.miner,
    header.stateRoot,
    header.transactionsRoot,
    header.receiptsRoot,
    header.logsBloom,
    toHex(BigInt(header.difficulty)),
    toHex(BigInt(header.number)),
    toHex(BigInt(header.gasLimit)),
    toHex(BigInt(header.gasUsed)),
    toHex(BigInt(header.timestamp)),
    header.extraData,
    header.mixHash,
    header.nonce,
  ];
  if (header.baseFeePerGas != null) fields.push(toHex(BigInt(header.baseFeePerGas)));
  if (header.withdrawalsRoot != null) fields.push(header.withdrawalsRoot);
  if (header.blobGasUsed != null) fields.push(toHex(BigInt(header.blobGasUsed)));
  if (header.excessBlobGas != null) fields.push(toHex(BigInt(header.excessBlobGas)));
  if (header.parentBeaconBlockRoot != null) fields.push(header.parentBeaconBlockRoot);
  if (header.requestsHash != null) fields.push(header.requestsHash);
  return toRlp(fields);
}
