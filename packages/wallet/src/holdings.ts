/**
 * Discover what a wallet holds. `balances` answers "how much of these tokens
 * do I have"; `holdings` answers "which tokens do I have" by asking the
 * Altana relay (ERC-7811 `wallet_getAssets`), then reading every discovered
 * token live through the same multicall path `balances` uses, so entries come
 * back in the familiar `TokenBalance` shape, BEP-677 scaling included.
 */

import { getAddress, hexToBigInt, isAddress, isHex, numberToHex, type Address, type Hex } from "viem";
import type { NetworkConfig } from "./config.js";
import type { TokenBalance } from "./balances.js";
import type { Wallet } from "./internal/types.js";
import {
  buildPublicClient,
  buildRelayClient,
  deepestRelayReason,
} from "./internal/relay.js";
import { readTokenBalances } from "./internal/tokenBalances.js";

export type HoldingsResult = {
  /** Native token balance in wei. */
  native: bigint;
  /**
   * Every ERC-20 the relay lists for the wallet on this chain, read live.
   * Zero balances are dropped unless `includeZero` was set; entries whose
   * reads failed (`ok: false`) are always kept so nothing disappears silently.
   */
  tokens: TokenBalance[];
};

/** One entry of the relay's ERC-7811 `wallet_getAssets` answer. */
type RelayAsset = {
  address: "native" | Address;
  balance: Hex;
  type: "native" | "erc20" | "erc721";
  metadata?: unknown;
};

/**
 * Lists a wallet's holdings on one chain.
 *
 * Asks the chain's Altana relay for the wallet's assets, then reads each ERC-20
 * it names on-chain via `readTokenBalances`. Throws when the chain has no
 * relay, when the relay call fails, or when the relay's answer is not in the
 * ERC-7811 shape.
 */
export async function holdings(
  walletOrAddress: Wallet | Address,
  opts: { network: NetworkConfig; includeZero?: boolean },
): Promise<HoldingsResult> {
  const network = opts.network;
  const address =
    typeof walletOrAddress === "string" ? walletOrAddress : walletOrAddress.address;

  const relay = buildRelayClient(network);
  const chainIdHex = numberToHex(network.chainId);

  let response: unknown;
  try {
    response = await relay.request({
      method: "wallet_getAssets",
      params: [
        {
          account: address,
          assetTypeFilter: ["native", "erc20"],
          chainFilter: [chainIdHex],
        },
      ],
    } as never);
  } catch (err) {
    const reason =
      deepestRelayReason(err) ??
      (err instanceof Error ? err.message : String(err));
    throw new Error(
      `The relay could not list holdings for ${address} on chain ${network.chainId}: ${reason}`,
      { cause: err },
    );
  }

  const assets = parseAssetsForChain(response, network.chainId, address);

  const seen = new Set<string>();
  const tokenAddresses: Address[] = [];
  let native: bigint | undefined;
  for (const asset of assets) {
    if (asset.type === "native" || asset.address === "native") {
      // Prefer the first native entry; ignore duplicates.
      if (native === undefined) native = hexToBigInt(asset.balance);
      continue;
    }
    if (asset.type !== "erc20") continue;
    const key = asset.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokenAddresses.push(getAddress(asset.address));
  }

  const publicClient = buildPublicClient(network);
  const [tokens, nativeFromChain] = await Promise.all([
    readTokenBalances(publicClient, address, tokenAddresses),
    native === undefined
      ? publicClient.getBalance({ address })
      : Promise.resolve(undefined),
  ]);

  const filtered = opts.includeZero
    ? tokens
    : tokens.filter((t) => !t.ok || t.raw !== 0n);

  return { native: native ?? nativeFromChain!, tokens: filtered };
}

function malformed(address: Address, chainId: number, what: string): Error {
  return new Error(
    `The relay returned a malformed wallet_getAssets response for ${address} on chain ${chainId}: ${what}`,
  );
}

/**
 * Pulls this chain's asset list out of the ERC-7811 response (a map keyed by
 * chain id as a hex quantity, e.g. "0x38"). A missing chain key means the
 * relay found nothing; a key that is present must hold a list of well-formed
 * entries or the whole response is rejected.
 */
function parseAssetsForChain(
  response: unknown,
  chainId: number,
  address: Address,
): RelayAsset[] {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw malformed(address, chainId, "expected an object keyed by chain id");
  }
  const target = BigInt(chainId);
  let list: unknown;
  for (const [key, value] of Object.entries(response as Record<string, unknown>)) {
    let id: bigint;
    try {
      id = BigInt(key);
    } catch {
      throw malformed(address, chainId, `chain key "${key}" is not a number`);
    }
    if (id === target) {
      list = value;
      break;
    }
  }
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw malformed(address, chainId, `entry for chain ${chainId} is not an array`);
  }
  return list.map((item, i) => {
    if (item === null || typeof item !== "object") {
      throw malformed(address, chainId, `asset #${i} is not an object`);
    }
    const a = item as Record<string, unknown>;
    const type = a.type;
    if (type !== "native" && type !== "erc20" && type !== "erc721") {
      throw malformed(address, chainId, `asset #${i} has unknown type ${JSON.stringify(type)}`);
    }
    const addr = a.address;
    if (addr !== "native" && !(typeof addr === "string" && isAddress(addr, { strict: false }))) {
      throw malformed(address, chainId, `asset #${i} has an invalid address ${JSON.stringify(addr)}`);
    }
    const balance = a.balance;
    if (typeof balance !== "string" || !isHex(balance)) {
      throw malformed(address, chainId, `asset #${i} has a non-hex balance ${JSON.stringify(balance)}`);
    }
    return {
      address: addr as "native" | Address,
      balance,
      type,
      ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
    };
  });
}
