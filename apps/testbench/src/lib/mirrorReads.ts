/**
 * The chain reads behind the mirror card, and the proof that changes it.
 *
 * Kept out of `sdk.ts` because these are direct RPC reads rather than relay
 * calls: the cache and the KeyStore are plain contracts, and the interesting
 * comparison (the KeyStore slot at the registry head against the same slot at
 * the block Celo anchors) is two `eth_getStorageAt` calls on one endpoint.
 * Reading the slot rather than calling `isValidKey` on the KeyStore is
 * deliberate: it is the exact value `populateKey` proves, so the card compares
 * like with like, and it needs no KeyStore ABI.
 */

import {
  computeKeyPackedSlot,
  isCachedRegistry,
  keyStoreCacheOf,
  networkByChainId,
  readCachedKey,
  readL1Anchor,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { relayReason } from "./errors";
import type { MirrorReading } from "./mirror";

/** The cached network's own cache address and the registry chain behind it. */
export function mirrorTargetsOf(network: NetworkConfig): { cache: Address; registry: NetworkConfig } {
  if (!isCachedRegistry(network)) {
    throw new Error(
      `${network.chain.name} (chainId ${network.chainId}) keeps its KeyStore locally, so it ` +
        `has no Celo-style mirror. Only a cached network such as Celo Sepolia has one.`,
    );
  }
  return { cache: keyStoreCacheOf(network), registry: network.registry.l1 };
}

export function publicClientFor(network: NetworkConfig): PublicClient {
  const url = network.publicRpcUrl ?? network.chain.rpcUrls.default.http[0];
  return createPublicClient({ chain: network.chain, transport: http(url) }) as PublicClient;
}

export type ReadMirrorArgs = {
  /** The cached network, for example Celo Sepolia. */
  network: NetworkConfig;
  user: Address;
  keyId: Hex;
  /** Overridable so tests and a fork run can point elsewhere. */
  l2Client?: PublicClient;
  l1Client?: PublicClient;
  now?: () => number;
  /** The registry block the registration landed in, when the caller knows it. */
  registrationL1Block?: bigint;
};

/**
 * One reading of everything the card needs: the anchor, the cache entry, and
 * the KeyStore slot at both the registry head and the anchored block.
 *
 * The anchored-block read is the one that can fail: it is 70 to 95 blocks
 * behind the Sepolia head, and some public endpoints serve only their newest
 * blocks. That failure is reported rather than swallowed, because silently
 * treating it as "absent" would show the operator a half-hour wait that is
 * really a wrong RPC.
 */
export async function readMirror(args: ReadMirrorArgs): Promise<MirrorReading> {
  const { network, user, keyId } = args;
  const { cache, registry } = mirrorTargetsOf(network);
  const l2Client = args.l2Client ?? publicClientFor(network);
  const l1Client = args.l1Client ?? publicClientFor(registry);
  const now = args.now ?? (() => Math.floor(Date.now() / 1000));

  const slot = computeKeyPackedSlot(user, keyId);
  const anchor = await readL1Anchor(l2Client);

  const [cached, l1Head, livePacked, anchorPacked] = await Promise.all([
    readCachedKey(l2Client, cache, user, keyId),
    l1Client.getBlockNumber(),
    l1Client.getStorageAt({ address: registry.keyStore, slot }),
    readSlotAtAnchor(l1Client, registry.keyStore, slot, anchor.number),
  ]);

  const cachedPresent = cached.publicKey !== undefined && cached.publicKey !== "0x" && cached.publicKey.length > 2;
  return {
    anchorL1Block: anchor.number,
    l1Head,
    livePacked: BigInt(livePacked ?? "0x0"),
    anchorPacked,
    cachedSourceBlock: cached.sourceBlockNumber,
    cachedRevoked: cached.revoked,
    cachedExpiry: Number(cached.expiry),
    cachedPresent,
    // isValidKey reverts when the entry is stale; the SDK maps that to false,
    // and the card derives the reason itself, so the bool is context only.
    cacheSaysValid: cachedPresent && cached.sourceBlockNumber === anchor.number && !cached.revoked,
    readAt: now(),
    ...(args.registrationL1Block !== undefined ? { registrationL1Block: args.registrationL1Block } : {}),
  };
}

async function readSlotAtAnchor(
  l1Client: PublicClient,
  keyStore: Address,
  slot: Hex,
  blockNumber: bigint,
): Promise<bigint> {
  try {
    const value = await l1Client.getStorageAt({ address: keyStore, slot, blockNumber });
    return BigInt(value ?? "0x0");
  } catch (err) {
    const text = relayReason(err);
    throw new Error(
      `The Ethereum Sepolia RPC would not read the KeyStore at block ${blockNumber}, the block ` +
        `Celo anchors: ${text.split("\n")[0]}. That block is 70 to 95 behind the Sepolia head and ` +
        `some public endpoints serve only their newest ones. Point the registry chain at an ` +
        `endpoint that keeps history with VITE_RPC_11155111.`,
      { cause: err },
    );
  }
}

/** The cached network the bench mirrors into, given a chain the user picked. */
export function cachedNetworkFor(chainId: number): NetworkConfig | undefined {
  const network = networkByChainId(chainId);
  return network && isCachedRegistry(network) ? network : undefined;
}
