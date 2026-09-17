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
  blockNumberOfWrite,
  buildPublicClient,
  buildRelayClient,
  faucetHint,
  submitCalls,
  waitForCalls,
  type Call,
  type RequiredFund,
} from "./relay.js";

import { NATIVE_TOKEN } from "../config.js";

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
  /** Set when the wallet's balance on this L2 paid for the write. */
  fundedFromChainId?: number;
  /** The source-chain transaction that locked the funds, when funded from an L2. */
  sourceTransactionHash?: Hex;
  /** The transaction that carried the write (the last one on the EOA path). */
  transactionHash?: Hex;
  /** Block the write landed in. Proofs must be anchored at or past it. */
  blockNumber?: bigint;
  /** Set when the write confirmed but its block could not be learned: why. Never prove without it. */
  blockNumberError?: string;
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
  /**
   * Relay path only. Defaults to the registry chain's native token, never the
   * execution chain's fee token: the registry chains (Ethereum, Sepolia)
   * accept native only today, so naming it is the fee token rule's outcome
   * without a round trip to the relay. Revisit if a registry chain's relay
   * ever lists other fee tokens.
   */
  feeToken?: Address;
  /** Public client for the registry chain. Built from the config when omitted. */
  registryClient?: PublicClient;
  /**
   * Relay path only. Whether the relay funds the write from the wallet's
   * balance on an L2. Undefined decides from the wallet's balance on the
   * registry chain: fund when it cannot cover the calls' value plus a fee
   * allowance.
   */
  fundFromL2?: boolean;
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
  const { network } = args;
  if (!isCachedRegistry(network)) {
    throw new Error(
      `submitRegistryCalls: ${network.chain.name} keeps its KeyStore locally; ` +
        `use submitCalls on the network itself.`,
    );
  }
  return submitRegistryWrite(network.registry.l1, args);
}

/**
 * Submits registry calls on a registry chain directly: through its relay when
 * it has one, otherwise as transactions from the admin key. Used for a
 * registry chain that is not itself one of the networks being operated on
 * (Sepolia behind Celo Sepolia and Base Sepolia, or Ethereum behind Celo when
 * the Ethereum account holds no copy of the key).
 */
export async function submitRegistryWrite(
  registry: NetworkConfig,
  args: Omit<SubmitRegistryCallsArgs, "network">,
): Promise<RegistryWriteResult> {
  const { walletAddress, adminSigner, calls } = args;
  const registryClient = args.registryClient ?? buildPublicClient(registry);
  const plan = planRegistryWrite(registry, adminSigner, walletAddress);

  if (plan.via === "relay") {
    // submitCalls prepends the admin registration itself on a local-registry
    // network, which the registry chain is.
    const relayClient = buildRelayClient(registry);
    let funding = await planRegistryFunding({
      registryClient,
      registry,
      walletAddress,
      adminPublicKey: adminSigner.publicKey,
      calls,
      ...(args.fundFromL2 !== undefined ? { override: args.fundFromL2 } : {}),
    });
    const submit = (f: RegistryFunding) =>
      submitCalls(relayClient, walletAddress, adminSigner, calls, {
        feeToken: f.fundFromL2 ? NATIVE_TOKEN : (args.feeToken ?? NATIVE_TOKEN),
        ...(f.requiredFunds ? { requiredFunds: f.requiredFunds } : {}),
        submittingKey: { type: "secp256k1", publicKey: adminSigner.publicKey, role: "admin" },
        network: registry,
      });
    let callsId: Hex;
    try {
      callsId = await submit(funding);
    } catch (err) {
      if (funding.fundFromL2 || !isSingleLeafRejection(err)) throw err;
      // The relay went cross-chain on its own for the fee and built a one-leaf
      // tree. Asking for the funding explicitly takes its working path.
      funding = await planRegistryFunding({
        registryClient,
        registry,
        walletAddress,
        adminPublicKey: adminSigner.publicKey,
        calls,
        override: true,
      });
      callsId = await submit(funding);
    }
    const result = await waitForCalls(relayClient, callsId, undefined, undefined, { chainId: registry.chainId });
    const block =
      result.status === "CONFIRMED"
        ? await blockNumberOfWrite({
            relayBlockNumber: result.blockNumber,
            transactionHash: result.transactionHash,
            publicClient: registryClient,
          })
        : undefined;
    const source = result.sourceReceipts?.[0];
    return {
      via: "relay",
      chainId: registry.chainId,
      status: result.status as RegistryWriteResult["status"],
      callsId,
      ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
      ...(block?.blockNumber !== undefined ? { blockNumber: block.blockNumber } : {}),
      ...(block && "blockNumberError" in block ? { blockNumberError: block.blockNumberError } : {}),
      ...(funding.fundFromL2 && source?.chainId !== undefined ? { fundedFromChainId: Number(source.chainId) } : {}),
      ...(funding.fundFromL2 && source?.transactionHash ? { sourceTransactionHash: source.transactionHash } : {}),
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
/** Headroom over the calls' value for the write's gas or relay fee. */
export const REGISTRY_FEE_ALLOWANCE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

export type RegistryFunding = {
  fundFromL2: boolean;
  /** The request to the relay when funding from an L2: the native value it must front. */
  requiredFunds?: readonly RequiredFund[];
};

/**
 * Whether a relayed registry write must be funded from the wallet's balance on
 * an L2: when its balance on the registry chain cannot cover the calls' value
 * plus the fee allowance. The requested value is at least one wei above the
 * balance so the relay always sources it (and its own fee) from another chain.
 */
/** The relay's "Cannot generate proof for single leaf tree": it sourced the fee cross-chain by itself and failed. */
export function isSingleLeafRejection(err: unknown): boolean {
  return /single leaf tree/i.test(err instanceof Error ? err.message : String(err));
}

export function decideRegistryFunding(args: {
  balance: bigint;
  valueNeeded: bigint;
  allowance?: bigint;
  override?: boolean;
}): RegistryFunding {
  const allowance = args.allowance ?? REGISTRY_FEE_ALLOWANCE_WEI;
  const fundFromL2 = args.override ?? args.balance < args.valueNeeded + allowance;
  if (!fundFromL2) return { fundFromL2: false };
  const value = args.valueNeeded > args.balance ? args.valueNeeded : args.balance + 1n;
  return { fundFromL2: true, requiredFunds: [{ address: NATIVE_TOKEN, value }] };
}

/** Reads what the write costs in value and what the wallet holds, then decides. */
export async function planRegistryFunding(args: {
  registryClient: PublicClient;
  registry: NetworkConfig;
  walletAddress: Address;
  adminPublicKey: Hex;
  calls: readonly Call[];
  override?: boolean;
}): Promise<RegistryFunding> {
  // The admin's first registration is prepended inside the relay request; its fee counts here.
  const prepend = await buildFirstActionPrepend({
    publicClient: args.registryClient,
    network: args.registry,
    walletAddress: args.walletAddress,
    adminPublicKey: args.adminPublicKey,
  });
  const valueNeeded = [...prepend, ...args.calls].reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  const balance = await args.registryClient.getBalance({ address: args.walletAddress });
  return decideRegistryFunding({ balance, valueNeeded, ...(args.override !== undefined ? { override: args.override } : {}) });
}

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
  const needed = requiredValue + REGISTRY_FEE_ALLOWANCE_WEI;
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
