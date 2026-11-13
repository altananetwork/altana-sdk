/**
 * Read-only KeyStore lookups shared by the stdio server (index.ts) and the
 * hosted remote server (remote.ts). Everything here works for ANY wallet
 * address — no key material, no local state — which is exactly what makes
 * these tools safe to expose from a public endpoint.
 *
 * On a cached-registry network (Celo, Celo Sepolia) the KeyStore lives on
 * the registry chain and a KeyStoreCache on the local chain mirrors it, so
 * reads go to `registryClient` and a `cache` block reports what the local
 * cache holds.
 */

import type { Address, Hex, PublicClient } from "viem";
import { isCachedRegistry, isCachedKeyValid, readCachedKey } from "@altananetwork/sdk";
import type { NetworkConfig } from "@altananetwork/sdk";

// Compact positioning surfaced at MCP handshake. Clients load this with
// every conversation; the full version is behind the `about_altana` tool.
export const SERVER_INSTRUCTIONS = `Altana Smart Agentic Wallet enables a global registry of permissions on-chain, accessible by any agent. Traditional agentic wallets store permissions locally or on centralized servers; Altana's KeyStore makes composable permissions accessible across any chain and any wallet. Call \`about_altana\` for the full positioning.`;

export const ABOUT_ALTANA = `# Altana Smart Agentic Wallet

Altana Smart Agentic Wallet enables a global registry of permissions on-chain, accessible by any agent.

Traditional agentic wallets store permissions locally or on centralized servers. Altana's **KeyStore** infrastructure makes composable permissions accessible across any chain and any wallet — enabling:

- **Agent-to-agent verification.** Two AIs acting on the same wallet can verify each other's authority on-chain. No platform in between.
- **Cross-app authorization.** Any DEX, orderbook, or protocol can read whether an agent is authorized — without integrating with the specific wallet vendor.
- **A new class of agent services.** Users hire AI agents through on-chain employment contracts. Anyone can verify what an agent is allowed to do, and revoke is one transaction.
`;

export const KEYSTORE_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    name: "getPublicKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bytes" }],
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

export function assertAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Not a valid 0x-prefixed 20-byte address: ${value}`);
  }
  return value as Address;
}

export function assertBytes32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Not a valid 0x-prefixed 32-byte hex: ${value}`);
  }
  return value as Hex;
}

/** The clients and network pair every KeyStore read needs. */
export type KeyStoreReadContext = {
  network: NetworkConfig;
  /** The chain the KeyStore registry lives on; same as `network` unless cached. */
  registry: NetworkConfig;
  /** Client on `network` — used for KeyStoreCache reads on cached networks. */
  publicClient: PublicClient;
  /** Client on `registry` — same object as `publicClient` on local-registry chains. */
  registryClient: PublicClient;
};

/**
 * On a cached network, what the local KeyStoreCache holds for (wallet, keyId).
 * `fresh` is the cache's own isValidKey: true only while the cache entry was
 * proven at the registry block the chain currently anchors, so a `false`
 * here with `cached: true` and `revoked: false` means the entry needs a new
 * proof (grant_session and revoke_session submit one; the SDK's
 * syncSessionToCache retries it). Undefined on local-registry chains.
 */
export async function cacheBlock(ctx: KeyStoreReadContext, addr: Address, keyId: Hex) {
  const network = ctx.network;
  if (!isCachedRegistry(network)) return undefined;
  const cache = network.registry.keyStoreCache;
  const base = { chainId: network.chainId, registryChainId: ctx.registry.chainId };
  try {
    const [entry, fresh] = await Promise.all([
      readCachedKey(ctx.publicClient, cache, addr, keyId),
      isCachedKeyValid(ctx.publicClient, cache, addr, keyId),
    ]);
    const cached = entry.publicKey !== "0x" && entry.publicKey.length > 2;
    return {
      ...base,
      deployed: true,
      keyStoreCache: cache,
      cached,
      revoked: entry.revoked,
      expiry: entry.expiry,
      ...(entry.expiry ? { expiresAt: new Date(entry.expiry * 1000).toISOString() } : {}),
      isRoot: entry.isRoot,
      sourceBlockNumber: entry.sourceBlockNumber.toString(),
      fresh,
    };
  } catch (err) {
    return {
      ...base,
      deployed: true,
      keyStoreCache: cache,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The wallet_verification payload: every authorized key on a wallet, with
 * its public key bytes (and the cache view on cached networks).
 */
export async function readWalletVerification(ctx: KeyStoreReadContext, address: string) {
  const addr = assertAddress(address);
  const keys = (await ctx.registryClient.readContract({
    address: ctx.registry.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "getKeys",
    args: [addr],
  })) as readonly Hex[];

  const details = await Promise.all(
    keys.map(async (keyId) => {
      const publicKey = (await ctx.registryClient.readContract({
        address: ctx.registry.keyStore,
        abi: KEYSTORE_ABI,
        functionName: "getPublicKey",
        args: [addr, keyId],
      })) as Hex;
      const cache = await cacheBlock(ctx, addr, keyId);
      return { keyId, publicKey, ...(cache ? { cache } : {}) };
    }),
  );

  return {
    address,
    keyStore: ctx.registry.keyStore,
    network: ctx.network.chain.name,
    ...(ctx.registry !== ctx.network ? { registryNetwork: ctx.registry.chain.name } : {}),
    activeKeyCount: keys.length,
    keys: details,
  };
}

/**
 * Single-call authorization check: "is this key authorized on this wallet
 * right now?" Returns the boolean plus the cache view on cached networks.
 */
export async function readAuthorization(ctx: KeyStoreReadContext, addr: Address, keyId: Hex) {
  const valid = (await ctx.registryClient.readContract({
    address: ctx.registry.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [addr, keyId],
  })) as boolean;
  const cache = await cacheBlock(ctx, addr, keyId);
  return {
    authorized: valid,
    ...(ctx.registry !== ctx.network ? { registryNetwork: ctx.registry.chain.name } : {}),
    ...(cache ? { cache } : {}),
  };
}
