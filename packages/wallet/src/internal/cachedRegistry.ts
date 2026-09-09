/**
 * Cached-registry networks (Celo Sepolia, Celo).
 *
 * On these networks the KeyStore lives on another chain (`registry.l1`) and
 * is mirrored into a KeyStoreCache contract on the network through storage
 * proofs. This module answers the three questions every registry write on
 * such a network has to settle:
 *
 *   1. Is this network cached at all, and where is its cache? (isCachedRegistry,
 *      keyStoreCacheOf)
 *   2. How does a registry write reach the registry chain? Through that
 *      chain's Altana relay when it has one (Ethereum), otherwise as a direct
 *      transaction from the admin's own key (Sepolia). (planRegistryWrite)
 *   3. Submit it, prepending the admin's own registration on the wallet's
 *      first registry write, and report what landed. (submitRegistryCalls)
 *
 * Nothing here touches the cache itself; proofs are built and submitted by
 * syncSessionToCache.
 */

import {
  createWalletClient,
  formatEther,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  KEYSTORE_CACHE_UNSET,
  type KeyStoreRegistry,
  type NetworkConfig,
} from "../config.js";
import { hasRawPrivateKey, type Signer } from "./signer.js";
import { isPasskeySigner } from "./passkey.js";
import { buildFirstActionPrepend } from "./keystore.js";
import {
  buildPublicClient,
  buildRelayClient,
  faucetHint,
  submitCalls,
  waitForCalls,
  type Call,
} from "./relay.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

export type CachedRegistry = Extract<KeyStoreRegistry, { kind: "cached" }>;

/** True when the network's KeyStore lives on another chain behind a local cache. */
export function isCachedRegistry(
  network: NetworkConfig,
): network is NetworkConfig & { registry: CachedRegistry } {
  return network.registry?.kind === "cached";
}

/**
 * The KeyStoreCache address on a cached network. Throws on a network with a
 * local registry (there is no cache) and on an unset address, so no proof is
 * ever sent to the zero address.
 */
export function keyStoreCacheOf(network: NetworkConfig): Address {
  if (!isCachedRegistry(network)) {
    throw new Error(
      `${network.chain.name} (chainId ${network.chainId}) keeps its KeyStore locally; ` +
        `there is no KeyStoreCache to sync to. Cache operations apply only to cached ` +
        `networks such as CELO_SEPOLIA.`,
    );
  }
  const cache = network.registry.keyStoreCache;
  if (cache.toLowerCase() === KEYSTORE_CACHE_UNSET) {
    throw new Error(
      `${network.chain.name} (chainId ${network.chainId}) has no KeyStoreCache address ` +
        `configured: set registry.keyStoreCache on the network config.`,
    );
  }
  return cache;
}

/**
 * The networks a wallet must be provisioned on for the given execution
 * networks: the networks themselves plus, for each cached network whose
 * registry chain has a relay, that registry chain. A passkey wallet cannot be
 * provisioned later (its throwaway EOA is discarded at creation), so the
 * registry chain's smart account has to be set up in the same call. Relay-less
 * registry chains (Sepolia) are left out: writes there come from the admin
 * EOA directly and need no smart account.
 */
export function provisioningNetworks(networks: readonly NetworkConfig[]): NetworkConfig[] {
  const out: NetworkConfig[] = [];
  const seen = new Set<number>();
  const push = (n: NetworkConfig) => {
    if (seen.has(n.chainId)) return;
    seen.add(n.chainId);
    out.push(n);
  };
  for (const network of networks) {
    push(network);
    if (isCachedRegistry(network) && network.registry.l1.relayUrl) {
      push(network.registry.l1);
    }
  }
  return out;
}

export type RegistryWritePlan =
  | { via: "relay"; registry: NetworkConfig }
  | { via: "eoa"; registry: NetworkConfig; account: PrivateKeyAccount };

/**
 * Decides how a registry write reaches the registry chain.
 *
 * - The registry chain has an Altana relay (Ethereum): the wallet's smart
 *   account submits the write through it, exactly like a local-registry
 *   network. Any signer type works.
 * - No relay (Sepolia): the write is a plain transaction from the admin's
 *   private key, which is the wallet address itself on a 7702 wallet. The
 *   KeyStore records `msg.sender`, so the signer's address must equal the
 *   wallet address. Passkey wallets cannot take this path: a P256 key
 *   cannot sign an Ethereum transaction, and there is no relay to wrap it.
 */
export function planRegistryWrite(
  registry: NetworkConfig,
  signer: Signer,
  walletAddress: Address,
): RegistryWritePlan {
  if (registry.relayUrl) {
    return { via: "relay", registry };
  }
  if (isPasskeySigner(signer) || !hasRawPrivateKey(signer)) {
    throw new Error(
      `Registry writes on ${registry.chain.name} (chainId ${registry.chainId}) are direct ` +
        `transactions from the admin's private key, because no Altana relay serves that ` +
        `chain. A passkey (P256) admin cannot sign one. On this testnet, grant the passkey ` +
        `wallet's sessions with register: false (account-only; the account still enforces ` +
        `permissions and expiry), or use a private-key admin for wallets that need a ` +
        `registry entry. On mainnet the registry chain (Ethereum) has a relay and passkey ` +
        `wallets register normally.`,
    );
  }
  const account = privateKeyToAccount(signer._privateKey);
  if (account.address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error(
      `Registry writes on ${registry.chain.name} (chainId ${registry.chainId}) are sent ` +
        `directly from the admin key, so the KeyStore records the sender as the wallet. ` +
        `The signer's address (${account.address}) is not the wallet address ` +
        `(${walletAddress}); the write would register keys for the wrong account.`,
    );
  }
  return { via: "eoa", registry, account };
}

export type RegistryWriteResult = {
  via: "relay" | "eoa";
  chainId: number;
  status: "CONFIRMED" | "FAILED" | "PENDING";
  /** The transaction that carried the write (the last one on the EOA path). */
  transactionHash?: Hex;
  /** Block the write landed in, when the receipt was read. Proofs must be anchored at or past it. */
  blockNumber?: bigint;
  /** Relay bundle id on the relay path. */
  callsId?: Hex;
};

export type SubmitRegistryCallsArgs = {
  /** The cached network being operated on. */
  network: NetworkConfig;
  walletAddress: Address;
  adminSigner: Signer;
  /** Registry calls (registerKey, revokeKey). Targets must be the registry chain's contracts. */
  calls: readonly Call[];
  /** Relay path only. Defaults to the registry chain's native token; never the execution chain's fee token. */
  feeToken?: Address;
  /** Public client for the registry chain. Built from the config when omitted. */
  registryClient?: PublicClient;
};

/**
 * Submits registry calls on the registry chain of a cached network. On both
 * paths the wallet's first registry write is preceded by
 * `initialRegisterKey(admin)` so the admin key lands in the KeyStore before
 * any session key does (the same guarantee submitCalls gives on local
 * networks).
 */
export async function submitRegistryCalls(
  args: SubmitRegistryCallsArgs,
): Promise<RegistryWriteResult> {
  const { network, walletAddress, adminSigner, calls } = args;
  if (!isCachedRegistry(network)) {
    throw new Error(
      `submitRegistryCalls: ${network.chain.name} keeps its KeyStore locally; ` +
        `use submitCalls on the network itself.`,
    );
  }
  const registry = network.registry.l1;
  const registryClient = args.registryClient ?? buildPublicClient(registry);
  const plan = planRegistryWrite(registry, adminSigner, walletAddress);

  if (plan.via === "relay") {
    // submitCalls prepends the admin registration itself on a local-registry
    // network, which the registry chain is.
    const relayClient = buildRelayClient(registry);
    const callsId = await submitCalls(relayClient, walletAddress, adminSigner, calls, {
      feeToken: args.feeToken ?? NATIVE_TOKEN,
      submittingKey: { type: "secp256k1", publicKey: adminSigner.publicKey, role: "admin" },
      network: registry,
    });
    const result = await waitForCalls(relayClient, callsId);
    let blockNumber: bigint | undefined;
    if (result.status === "CONFIRMED" && result.transactionHash) {
      try {
        const receipt = await registryClient.getTransactionReceipt({ hash: result.transactionHash });
        blockNumber = receipt.blockNumber;
      } catch {
        // The relay confirmed; a lagging public RPC is not a failure of the write.
      }
    }
    return {
      via: "relay",
      chainId: registry.chainId,
      status: result.status as RegistryWriteResult["status"],
      callsId,
      ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    };
  }

  const prepend = await buildFirstActionPrepend({
    publicClient: registryClient,
    network: registry,
    walletAddress,
    adminPublicKey: adminSigner.publicKey,
  });
  const allCalls: readonly Call[] = prepend.length > 0 ? [...prepend, ...calls] : calls;

  const required = allCalls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  await assertRegistryFunding(registryClient, registry, plan.account.address, required);

  const walletClient = createWalletClient({
    account: plan.account,
    chain: registry.chain,
    transport: http(registry.publicRpcUrl),
  });

  let last: { hash: Hex; blockNumber: bigint } | undefined;
  for (const call of allCalls) {
    const hash = await walletClient.sendTransaction({
      to: call.to,
      value: call.value ?? 0n,
      data: call.data ?? "0x",
    });
    const receipt = await registryClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return {
        via: "eoa",
        chainId: registry.chainId,
        status: "FAILED",
        transactionHash: hash,
        blockNumber: receipt.blockNumber,
      };
    }
    last = { hash, blockNumber: receipt.blockNumber };
  }
  return {
    via: "eoa",
    chainId: registry.chainId,
    status: "CONFIRMED",
    ...(last ? { transactionHash: last.hash, blockNumber: last.blockNumber } : {}),
  };
}

/** Rough gas allowance for one direct registry transaction (registerKey is ~150k gas at a few gwei). */
const REGISTRY_GAS_ALLOWANCE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * Throws when `address` cannot pay the direct registry write on the registry
 * chain: the registration fees plus a gas allowance. The message names the
 * chain and the asset to fund, with the faucet where one exists.
 */
export async function assertRegistryFunding(
  registryClient: Pick<PublicClient, "getBalance">,
  registry: NetworkConfig,
  address: Address,
  requiredValue: bigint,
): Promise<void> {
  const needed = requiredValue + REGISTRY_GAS_ALLOWANCE_WEI;
  const balance = await registryClient.getBalance({ address });
  if (balance >= needed) return;
  const symbol = registry.chain.nativeCurrency.symbol;
  const faucet = faucetHint(registry.chainId);
  throw new Error(
    `Registry writes on ${registry.chain.name} (chainId ${registry.chainId}) are sent ` +
      `directly from the admin key ${address}, which holds ${formatEther(balance)} ${symbol} ` +
      `but needs about ${formatEther(needed)} ${symbol} (registration fee plus gas). ` +
      `Fund ${address} with ${symbol} on ${registry.chain.name}` +
      (faucet ? ` (faucet: ${faucet}).` : "."),
  );
}
