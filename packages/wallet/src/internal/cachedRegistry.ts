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
 *      chain's Altana relay when it has one (Ethereum, Sepolia), paid from the
 *      wallet's balance on the L2 being operated on; otherwise as a direct
 *      transaction from the admin's own key. (planRegistryWrite)
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
import type { RootRegistrationLeg } from "./sessions.js";
import {
  blockNumberOfWrite,
  buildPublicClient,
  buildRelayClient,
  faucetHint,
  submitCalls,
  waitForCalls,
  type Call,
  type RequiredFund,
  type RelayReceipt,
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
  /** The L2 whose balance paid for the write: every relayed write on a cached network, as the relay's receipts report it. */
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
  /**
   * The root (`initialRegisterKey`) intent of a first-time write, when one was
   * needed. This result's own fields always describe the session write.
   */
  rootRegistration?: RootRegistrationLeg;
  /** Why the write failed, in the relay's or the chain's own words. */
  reason?: string;
};

export type SubmitRegistryCallsArgs = {
  /** The cached network being operated on. */
  network: NetworkConfig;
  walletAddress: Address;
  adminSigner: Signer;
  /** Registry calls (registerKey, revokeKey). Targets must be the registry chain's contracts. */
  calls: readonly Call[];
  /** Public client for the registry chain. Built from the config when omitted. */
  registryClient?: PublicClient;
  /**
   * Called before each intent of the write. A wallet's FIRST registry write is
   * two intents, `root` then `session`; every later write is `session` only.
   */
  onStep?: (step: "root" | "session") => void;
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
 * Why a relayed write did not confirm, in enough detail to chase it.
 *
 * `relay reported status FAILED` was the whole of it, and it is the fourth
 * contentless diagnostic this project has lost time to: the bundle id, the
 * numeric status and the per-chain receipts were all in hand and none of them
 * reached the leg. A reader could not tell an intent that never landed from one
 * that landed and reverted, and those are different investigations.
 */
function describeRelayFailure(
  callsId: Hex,
  result: { status: string; statusCode?: number; receipts?: readonly RelayReceipt[] },
): string {
  const parts = [`the relay reported status ${result.status}`];
  if (result.statusCode !== undefined) parts.push(`statusCode ${result.statusCode}`);
  parts.push(`bundle ${callsId}`);
  const receipts = result.receipts ?? [];
  if (receipts.length === 0) {
    // No receipt at all: the intent never reached a block, so there is nothing
    // on chain to inspect and the relay is where the answer is.
    parts.push("the relay returned no receipt, so the intent did not land in a block");
  } else {
    for (const r of receipts) {
      const chain = r.chainId === undefined ? "unknown chain" : `chain ${Number(r.chainId)}`;
      const status = r.status === undefined ? "no status" : Number(r.status) === 1 ? "succeeded" : "REVERTED";
      parts.push(`${chain}: ${status}${r.transactionHash ? ` in ${r.transactionHash}` : ""}`);
    }
  }
  return parts.join("; ");
}

/**
 * One relayed registry intent, reported as a root-registration outcome.
 *
 * Used for the `initialRegisterKey` half of a first-time write.
 *
 * It throws when the intent cannot be submitted, exactly as a single-intent
 * write always has: the fee-selection code builds a careful diagnosis for that
 * case (a bare revert must not be dressed up as a shortfall, see
 * `relay.feeSelection.test.ts`), and `realSessionLegDeps.submitRegistry`
 * already turns a throw into a FAILED leg carrying the message. Returning an
 * outcome here instead would have made the same underlying failure throw or
 * not depending on which of the two intents hit it.
 *
 * A submitted intent that the relay reports as not CONFIRMED is a different
 * thing and comes back as a FAILED outcome, because then the caller has a
 * bundle id and a reason to report.
 */
async function submitOneRelayedWrite(args: {
  relayClient: ReturnType<typeof buildRelayClient>;
  registryClient: PublicClient;
  registry: NetworkConfig;
  walletAddress: Address;
  adminSigner: Signer;
  calls: readonly Call[];
}): Promise<RootRegistrationLeg> {
  const { registry, walletAddress, adminSigner, calls, registryClient } = args;
  try {
    const requiredFunds = await planRegistryFunding({
      registryClient,
      registry,
      walletAddress,
      adminPublicKey: adminSigner.publicKey,
      calls,
      // `calls` is the registration itself, so its fee is counted once.
      skipFirstActionPrepend: true,
    });
    const callsId = await submitCalls(args.relayClient, walletAddress, adminSigner, calls, {
      feeToken: NATIVE_TOKEN,
      requiredFunds,
      submittingKey: { type: "secp256k1", publicKey: adminSigner.publicKey, role: "admin" },
      network: registry,
      // These calls ARE the first-action registration, so submitCalls must not
      // prepend it again: it would register the admin key twice in one intent
      // and pay the fee twice.
      skipFirstActionPrepend: true,
    });
    const result = await waitForCalls(args.relayClient, callsId, undefined, undefined, {
      chainId: registry.chainId,
    });
    const block =
      result.status === "CONFIRMED"
        ? await blockNumberOfWrite({
            relayBlockNumber: result.blockNumber,
            transactionHash: result.transactionHash,
            publicClient: registryClient,
          })
        : undefined;
    return {
      status: result.status === "CONFIRMED" ? "CONFIRMED" : "FAILED",
      callsId,
      ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}),
      ...(block?.blockNumber !== undefined ? { blockNumber: block.blockNumber } : {}),
      ...(result.status !== "CONFIRMED" ? { reason: describeRelayFailure(callsId, result) } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The root registration (initialRegisterKey) could not be submitted, so the session ` +
        `key's registerKey was not attempted. ${message}`,
    );
  }
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
    // The wallet pays the write from its balance on the L2, in the registry
    // chain's native token: the relay fronts the value and its own fee here.
    const relayClient = buildRelayClient(registry);

    // A wallet's FIRST registry write is two calls, initialRegisterKey then
    // registerKey, and submitCalls would bundle them into one intent. Measured
    // on Celo Sepolia at the 1,500,000 intent buffer, initialRegisterKey alone
    // costs 1,077,101 gas cold (KeyStore.initialRegisterKey 1,008,273), which
    // leaves registerKey 44,555 of the intent's budget: it runs out of gas and
    // the Orchestrator returns CallError() (infra, 2026-10-07). So send them as
    // two sequential intents, each quoted for its own gas.
    //
    // They do not need to be atomic, and the EOA path below has always worked
    // this way: one transaction per call, each confirmed before the next. What
    // orders them is the sequence, not the bundling — KeyStore requires a root
    // key before registerKey, and confirming the root intent first satisfies
    // that across two intents exactly as within one.
    const prepend = await buildFirstActionPrepend({
      publicClient: registryClient,
      network: registry,
      walletAddress,
      adminPublicKey: adminSigner.publicKey,
    });

    let rootRegistration: RootRegistrationLeg | undefined;
    if (prepend.length > 0) {
      args.onStep?.("root");
      rootRegistration = await submitOneRelayedWrite({
        relayClient,
        registryClient,
        registry,
        walletAddress,
        adminSigner,
        calls: prepend,
      });
      if (rootRegistration.status !== "CONFIRMED") {
        return {
          via: "relay",
          chainId: registry.chainId,
          status: "FAILED",
          rootRegistration,
          reason:
            `the root registration (initialRegisterKey) did not confirm, so the session ` +
            `key's registerKey was not attempted: ${rootRegistration.reason ?? "no reason reported"}`,
        };
      }
      // The session intent must NOT prepend the registration again. Leaving
      // submitCalls to work that out from its own KeyStore read would make
      // this depend on read-after-write consistency on the registry chain: a
      // lagging or load-balanced RPC still answering `getKeys() == []` would
      // prepend initialRegisterKey a second time and pay its fee twice. We
      // just confirmed the root ourselves, so we say so instead of asking.
    }
    const rootHandled = prepend.length > 0;

    args.onStep?.("session");
    const requiredFunds = await planRegistryFunding({
      registryClient,
      registry,
      walletAddress,
      adminPublicKey: adminSigner.publicKey,
      calls,
      // Counted in the root intent already, when there was one.
      ...(rootHandled ? { skipFirstActionPrepend: true } : {}),
    });
    const callsId = await submitCalls(relayClient, walletAddress, adminSigner, calls, {
      // Only when we registered the root ourselves. With no root intent the
      // prepend stays submitCalls's job, as it has always been.
      ...(rootHandled ? { skipFirstActionPrepend: true } : {}),
      feeToken: NATIVE_TOKEN,
      requiredFunds,
      submittingKey: { type: "secp256k1", publicKey: adminSigner.publicKey, role: "admin" },
      network: registry,
    });
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
      ...(source?.chainId !== undefined ? { fundedFromChainId: Number(source.chainId) } : {}),
      ...(source?.transactionHash ? { sourceTransactionHash: source.transactionHash } : {}),
      ...(rootRegistration ? { rootRegistration } : {}),
      ...(result.status !== "CONFIRMED"
        ? {
            reason: rootHandled
              ? `the session key's registerKey did not confirm. The root registration DID ` +
                `confirm, so retrying grantSession sends registerKey only. ` +
                describeRelayFailure(callsId, result)
              : describeRelayFailure(callsId, result),
          }
        : {}),
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

  // One transaction per call, each confirmed before the next: the same two-step
  // shape the relay path above now uses. `last` is the SESSION write, so the
  // returned blockNumber stays the one a cache proof must be anchored at.
  let last: { hash: Hex; blockNumber: bigint } | undefined;
  let eoaRoot: RootRegistrationLeg | undefined;
  for (const [i, call] of allCalls.entries()) {
    const isRoot = prepend.length > 0 && i === 0;
    args.onStep?.(isRoot ? "root" : "session");
    const hash = await walletClient.sendTransaction({
      to: call.to,
      value: call.value ?? 0n,
      data: call.data ?? "0x",
    });
    const receipt = await registryClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      const failed: RootRegistrationLeg = {
        status: "FAILED",
        transactionHash: hash,
        blockNumber: receipt.blockNumber,
        reason: "the transaction reverted",
      };
      return {
        via: "eoa",
        chainId: registry.chainId,
        status: "FAILED",
        transactionHash: hash,
        blockNumber: receipt.blockNumber,
        ...(isRoot ? { rootRegistration: failed } : eoaRoot ? { rootRegistration: eoaRoot } : {}),
        reason: isRoot
          ? "the root registration (initialRegisterKey) reverted, so registerKey was not attempted"
          : eoaRoot
            ? "the session key's registerKey reverted. The root registration DID confirm, " +
              "so retrying grantSession sends registerKey only."
            : "the registry transaction reverted",
      };
    }
    if (isRoot) eoaRoot = { status: "CONFIRMED", transactionHash: hash, blockNumber: receipt.blockNumber };
    else last = { hash, blockNumber: receipt.blockNumber };
  }
  // `last` is the session write. With no session call to make (an empty
  // `calls`, which no caller does today) fall back to the root's receipt
  // rather than returning CONFIRMED with no block for a proof to anchor at.
  const reported = last ?? (eoaRoot?.transactionHash && eoaRoot.blockNumber !== undefined
    ? { hash: eoaRoot.transactionHash, blockNumber: eoaRoot.blockNumber }
    : undefined);
  return {
    via: "eoa",
    ...(eoaRoot ? { rootRegistration: eoaRoot } : {}),
    chainId: registry.chainId,
    status: "CONFIRMED",
    ...(reported ? { transactionHash: reported.hash, blockNumber: reported.blockNumber } : {}),
  };
}

/** Gas headroom over the calls' value for a direct (EOA) registry transaction. */
export const REGISTRY_FEE_ALLOWANCE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

/**
 * The native value a relayed registry write asks the relay to front: the
 * calls' value, or one wei above what the wallet holds on the registry chain
 * when that is more. The relay funds a request only when it exceeds the
 * balance it reads itself, and then sources the value and its own fee from
 * the wallet's balance on the L2; so the wallet always pays from its own
 * chain and ETH it holds on the registry chain is not used. Should a deposit
 * land there between this read and the relay's, the relay pays the write
 * from that ETH instead and the leg carries no source chain; it still lands.
 */
export function registryFundsRequest(args: { balance: bigint; valueNeeded: bigint }): readonly RequiredFund[] {
  const value = args.valueNeeded > args.balance ? args.valueNeeded : args.balance + 1n;
  return [{ address: NATIVE_TOKEN, value }];
}

/** Reads what the write costs in value and what the wallet holds on the registry chain, then builds the request. */
export async function planRegistryFunding(args: {
  registryClient: PublicClient;
  registry: NetworkConfig;
  walletAddress: Address;
  adminPublicKey: Hex;
  calls: readonly Call[];
  /**
   * Set when `calls` IS the first-action registration, so its fee is not
   * counted twice. The root intent of a first-time write passes it, matching
   * `submitCalls`'s option of the same name.
   */
  skipFirstActionPrepend?: boolean;
}): Promise<readonly RequiredFund[]> {
  // The admin's first registration is prepended inside the relay request; its fee counts here.
  const prepend = args.skipFirstActionPrepend
    ? []
    : await buildFirstActionPrepend({
        publicClient: args.registryClient,
        network: args.registry,
        walletAddress: args.walletAddress,
        adminPublicKey: args.adminPublicKey,
      });
  const valueNeeded = [...prepend, ...args.calls].reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  const balance = await args.registryClient.getBalance({ address: args.walletAddress });
  return registryFundsRequest({ balance, valueNeeded });
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
