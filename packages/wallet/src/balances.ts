import { type NetworkConfig } from "./config.js";
import { buildPublicClient } from "./internal/relay.js";
import type { Address } from "viem";
import type { Wallet } from "./internal/types.js";

export type BalancesResult = {
  /** Native token balance in wei. */
  native: bigint;
};

/**
 * Reads on-chain balances for a wallet.
 *
 * v0 returns native balance only. ERC-20 balances will land alongside the v1
 * DeFi recipes (the recipes know which tokens are interesting per protocol).
 */
export async function balances(
  walletOrAddress: Wallet | Address,
  opts: { network: NetworkConfig },
): Promise<BalancesResult> {
  const network = opts.network;
  const address = typeof walletOrAddress === "string"
    ? walletOrAddress
    : walletOrAddress.address;

  const publicClient = buildPublicClient(network);
  const native = await publicClient.getBalance({ address });

  return { native };
}
