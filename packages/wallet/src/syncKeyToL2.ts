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
 *
 * The same building blocks serve cached networks such as Celo Sepolia, where
 * the SDK submits the proof as a wallet call through the network's relay
 * (see syncSessionToCache): `buildPopulateKeyCall` produces the call,
 * `waitForL1Anchor` waits for the L2 to see the L1 block that holds the
 * registry write, and `computeKeyPackedSlot` is the storage slot proven.
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
const ZERO_HASH: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

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
  {
    inputs: [],
    name: "number",
    outputs: [{ type: "uint64" }],
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
 * was populated at an older L1 block than the one the L2 currently sees,
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

/** The L1 block an OP-stack L2 currently anchors, as its `L1Block` predeploy reports it. */
export type L1Anchor = {
  hash: Hex;
  number: bigint;
};

/**
 * Reads the L2's `L1Block` predeploy: the L1 block hash and number the L2
 * currently anchors. Throws when the predeploy reports a zero hash (the
 * chain has no anchor yet).
 */
export async function readL1Anchor(l2Client: PublicClient): Promise<L1Anchor> {
  const [hash, number] = await Promise.all([
    l2Client.readContract({
      address: L1_BLOCK_PREDEPLOY,
      abi: L1_BLOCK_ABI,
      functionName: "hash",
    }) as Promise<Hex>,
    l2Client.readContract({
      address: L1_BLOCK_PREDEPLOY,
      abi: L1_BLOCK_ABI,
      functionName: "number",
    }) as Promise<bigint>,
  ]);
  if (hash === ZERO_HASH) {
    throw new Error("L2 L1Block predeploy reports zero hash: chain not anchored yet");
  }
  return { hash, number: BigInt(number) };
}

export type WaitForL1AnchorArgs = {
  /** Public client for the L1 chain, used to resolve the anchored hash to a block number. */
  l1Client: PublicClient;
  /** Public client for the L2 chain, used to read the `L1Block` predeploy. */
  l2Client: PublicClient;
  /**
   * The L1 block the anchor must reach. Pass the block that holds the
   * registry write you want proven; anything older risks the storage slot
   * not yet being set in the proven state.
   */
  targetL1Block: bigint;
  /** Poll cadence. Default 3s. */
  pollIntervalMs?: number;
  /** Give-up timeout. Default 30 minutes. */
  timeoutMs?: number;
  /** Prefix for the timeout error. Default "waitForL1Anchor". */
  label?: string;
};

/**
 * Polls the L2's `L1Block` predeploy until it anchors an L1 block at or past
 * `targetL1Block`, and returns that anchor. Base anchors 1 to 3 minutes
 * behind L1; Celo Sepolia within a few L1 blocks.
 */
export async function waitForL1Anchor(args: WaitForL1AnchorArgs): Promise<L1Anchor> {
  const {
    l1Client,
    l2Client,
    targetL1Block,
    pollIntervalMs = 3_000,
    // Base anchors 1 to 3 minutes behind L1; Celo Sepolia's L1Block predeploy
    // advances only about every 20 minutes and lags Sepolia by 15 to 20
    // minutes, so a proof for a fresh registry write can need close to half
    // an hour. Callers on faster chains can pass a shorter timeout.
    timeoutMs = 30 * 60_000,
    label = "waitForL1Anchor",
  } = args;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const l1HashOnL2 = (await l2Client.readContract({
      address: L1_BLOCK_PREDEPLOY,
      abi: L1_BLOCK_ABI,
      functionName: "hash",
    })) as Hex;
    if (l1HashOnL2 !== ZERO_HASH) {
      const anchored = await l1Client.getBlock({ blockHash: l1HashOnL2 });
      if (anchored.number >= targetL1Block) {
        return { hash: l1HashOnL2, number: anchored.number };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${label}: L2 did not anchor past L1 block ${targetL1Block} within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

export type SyncKeyToL2Args = {
  /** Public client for the L1 chain (Ethereum), used for eth_getProof and block lookup. */
  l1Client: PublicClient;
  /** Public client for the L2 chain (e.g. Base), used for L1Block read + receipt wait. */
  l2Client: PublicClient;
  /** Wallet client on the L2 chain: the relayer that pays L2 gas. */
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
 * has been read back. Single shot: if `keccak(blockHeader) != L1Block.hash()`
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

  const call = await buildPopulateKeyCall({
    l1Client,
    l2Client,
    l1KeyStore,
    l2Cache,
    user,
    publicKey,
  });

  const txHash = await l2WalletClient.sendTransaction({
    account: l2WalletClient.account,
    chain: l2WalletClient.chain,
    to: call.to,
    data: call.data,
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
   * Max wait for the L1 anchor before giving up. Default 30 minutes.
   * Base typically anchors within 1–3 minutes.
   */
  anchorTimeoutMs?: number;
};

/**
 * Idempotent "sync if needed" wrapper around `syncKeyToL2`. Reads the L2
 * cache first; if the key is already active, returns immediately. Otherwise
 * waits for the L2 to be anchored to a usable L1 block, then submits the
 * proof.
 *
 * Opt-in: `execute()` does not call this. Integrators invoke it themselves
 * before the first action on an L2.
 *
 * Not a way to propagate a revocation. The early return fires whenever the
 * cache reports the key as valid, which is exactly the stale state a
 * revocation leaves behind, so this would return `cache-hit` and never
 * submit the correcting proof. Call `syncKeyToL2` directly for that.
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
    anchorTimeoutMs = 30 * 60_000,
  } = args;

  const keyId = keccak256(publicKey);

  if (await isCachedKeyValid(l2Client, l2Cache, user, keyId)) {
    onStatus?.("cache-hit");
    return readCachedKey(l2Client, l2Cache, user, keyId);
  }

  // We need an L1 block that already contains the registration. Wait until
  // the L2's L1Block predeploy reports a hash that resolves to a block at
  // or past the current L1 tip; anything older risks the storage slot
  // not yet being set in the proven account.
  onStatus?.("waiting-for-anchor");
  const targetL1Block = await l1Client.getBlockNumber();
  await waitForL1Anchor({
    l1Client,
    l2Client,
    targetL1Block,
    pollIntervalMs: anchorPollIntervalMs,
    timeoutMs: anchorTimeoutMs,
    label: "ensureKeyCached",
  });

  onStatus?.("submitting-proof");
  const result = await syncKeyToL2(args);
  onStatus?.("done");
  return result.cachedKey;
}

export type BuildPopulateKeyCallArgs = {
  /** Public client for the L1 chain, used for eth_getProof and the header fetch. */
  l1Client: PublicClient;
  /** Public client for the L2 chain, used to read the current L1 anchor. */
  l2Client: PublicClient;
  /** L1 KeyStore address whose state is being proven. */
  l1KeyStore: Address;
  /** L2 KeyStoreCache address that will accept the proof. */
  l2Cache: Address;
  /** The user whose key is being proven. */
  user: Address;
  /** Full SEC1-encoded public key bytes of the key being proven. */
  publicKey: Hex;
  /**
   * The anchor to build the proof against. Omit to read the L2's current
   * anchor; pass the value from `waitForL1Anchor` to avoid a second read.
   */
  anchor?: L1Anchor;
};

export type PopulateKeyCall = {
  to: Address;
  value: bigint;
  data: Hex;
  /** The L1 block the proof was built against. The cache only accepts it while the L2 still anchors this block. */
  l1BlockNumber: bigint;
  l1BlockHash: Hex;
};

/**
 * Builds the `populateKey` call that proves (user, publicKey)'s current L1
 * KeyStore state into an L2 cache: the RLP-encoded L1 header the L2 anchors,
 * the account proof for the KeyStore and the storage proof for the packed
 * Key slot, all fetched at the anchored block. Send it from any funded L2
 * account, or as a wallet call through the network's relay.
 *
 * The L1 RPC must serve `eth_getProof` for the anchored block. Public
 * endpoints often only serve the latest few blocks and answer "distance to
 * target block exceeds maximum proof window" otherwise; point the L1 client
 * at an endpoint with historical proofs when that happens.
 */
export async function buildPopulateKeyCall(
  args: BuildPopulateKeyCallArgs,
): Promise<PopulateKeyCall> {
  const { l1Client, l2Client, l1KeyStore, l2Cache, user, publicKey } = args;
  const keyId = keccak256(publicKey);

  const anchor = args.anchor ?? (await readL1Anchor(l2Client));

  const l1Block = await l1Client.getBlock({ blockHash: anchor.hash });
  const packedSlot = computeKeyPackedSlot(user, keyId);

  let proof;
  try {
    proof = await l1Client.getProof({
      address: l1KeyStore,
      storageKeys: [packedSlot],
      blockNumber: l1Block.number,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/proof window|distance to target block/i.test(text)) {
      throw new Error(
        `The L1 RPC refused eth_getProof at block ${l1Block.number} (the block the L2 ` +
          `anchors): ${text.split("\n")[0]}. This endpoint only serves proofs for its ` +
          `newest blocks. Use an L1 RPC with a proof window that covers the anchor (for ` +
          `Sepolia, https://0xrpc.io/sep or https://eth-sepolia.api.onfinality.io/public) ` +
          `by overriding the registry network's publicRpcUrl or passing l1Client.`,
        { cause: err },
      );
    }
    throw err;
  }

  const rlpHeader = rlpEncodeHeader(l1Block);
  if (keccak256(rlpHeader).toLowerCase() !== l1Block.hash.toLowerCase()) {
    throw new Error(
      `RLP header encoding does not hash to block hash; block schema likely changed (computed=${keccak256(rlpHeader)}, expected=${l1Block.hash})`,
    );
  }

  const data = encodeFunctionData({
    abi: POPULATE_KEY_ABI,
    functionName: "populateKey",
    args: [user, publicKey, rlpHeader, proof.accountProof, proof.storageProof[0]!.proof],
  });

  return {
    to: l2Cache,
    value: 0n,
    data,
    l1BlockNumber: l1Block.number,
    l1BlockHash: l1Block.hash,
  };
}

/**
 * Storage slot of the packed Key field (offset 3) inside
 * `userKeys[user][keyId]` in the L1 KeyStore v1.0.0. The packed slot holds
 * `(nonce|lastUpdated|revoked|expiry|isRoot)` and is exactly what the L2
 * cache reads to extract revocation / expiry / root status. Mirrors
 * `KeyStoreCacheOPStack.keyPackedSlot`.
 */
export function computeKeyPackedSlot(user: Address, keyId: Hex): Hex {
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
