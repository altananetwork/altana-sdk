/**
 * Relay layer. Wraps the upstream relay provider so the public API never
 * imports it directly.
 */

import {
  prepareUpgradeAccount,
  upgradeAccount,
  addFaucetFunds,
  prepareCalls,
  signCalls,
  sendPreparedCalls,
  getCallsStatus,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import {
  createClient,
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { NetworkConfig } from "../config.js";
import { hasRawPrivateKey, type Signer } from "./signer.js";
import {
  isPasskeySigner,
  passkeyToPortoKey,
  type PasskeySigner,
} from "./passkey.js";
import { buildFirstActionPrepend } from "./keystore.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

export function buildRelayClient(network: NetworkConfig) {
  if (!network.relayUrl) {
    throw new Error(
      `No relay is configured for chain ${network.chainId} (${network.chain.name}). ` +
        `The Altana relay serves mainnets; the Altana testnet relay serves BSC ` +
        `testnet (97); Sepolia and Base Sepolia are served by the Porto relay ` +
        `(PORTO_RELAY_URL). Set relayUrl on the network config to execute here.`,
    );
  }
  return createClient({
    chain: network.chain,
    transport: http(network.relayUrl, { timeout: 60_000 }),
  });
}

export function buildPublicClient(network: NetworkConfig): PublicClient {
  return createPublicClient({
    chain: network.chain,
    transport: http(network.publicRpcUrl),
  });
}

/**
 * Bootstrap a smart-account wallet for the given signer and return the
 * wallet's address. Counterfactual — no on-chain action; the setCode lands
 * as a preCall on the first execute.
 *
 *  - privateKey signers: the signer's own EOA address is the wallet address;
 *    the signer signs the EIP-7702 authorization directly.
 *  - passkey signers: EIP-7702 setCode requires a secp256k1 signature on the
 *    authorization tuple, but a passkey is P256. We generate a one-shot
 *    throwaway secp256k1, use it to sign the upgrade with the passkey listed
 *    as `authorizeKeys`, then discard the throwaway. The wallet address is
 *    the throwaway's EOA address, and the only authority on the smart
 *    account from that point forward is the passkey.
 */
export async function registerAccount(
  client: ReturnType<typeof buildRelayClient>,
  signer: Signer,
): Promise<{ walletAddress: Address }> {
  if (hasRawPrivateKey(signer)) {
    const adminKey = Key.fromSecp256k1({
      privateKey: signer._privateKey,
      role: "admin",
    });
    const account = privateKeyToAccount(signer._privateKey);

    const prepared: any = await prepareUpgradeAccount(client, {
      address: account.address,
      authorizeKeys: [adminKey],
    });

    const signatures: Record<string, Hex> = {};
    for (const [name, digest] of Object.entries(prepared.digests ?? {})) {
      signatures[name] = await signer.signDigest(digest as Hex);
    }

    await upgradeAccount(client as any, {
      context: prepared.context,
      signatures,
    } as any);

    return { walletAddress: account.address };
  }

  if (isPasskeySigner(signer)) {
    // One-shot throwaway EOA. Lives only for the duration of this function;
    // discarded when it goes out of scope. The passkey is the lasting
    // authority via authorizeKeys.
    const throwawayPk = generatePrivateKey();
    const throwawayAccount = privateKeyToAccount(throwawayPk);
    const passkeyAdminKey = passkeyToPortoKey(signer, { role: "admin" });

    const prepared: any = await prepareUpgradeAccount(client, {
      address: throwawayAccount.address,
      authorizeKeys: [passkeyAdminKey],
    });

    const signatures: Record<string, Hex> = {};
    for (const [name, digest] of Object.entries(prepared.digests ?? {})) {
      signatures[name] = await throwawayAccount.sign({ hash: digest as Hex });
    }

    await upgradeAccount(client as any, {
      context: prepared.context,
      signatures,
    } as any);

    return { walletAddress: throwawayAccount.address };
  }

  throw new Error(unsupportedSignerMessage(signer.type, "create a wallet"));
}

/** Fund an EOA with native tokens via the upstream relay's faucet (test networks only). */
export async function fundNative(
  client: ReturnType<typeof buildRelayClient>,
  address: Address,
  amount: bigint,
): Promise<{ transactionHash: Hex }> {
  const result = await addFaucetFunds(client as any, {
    address,
    tokenAddress: NATIVE_TOKEN,
    value: amount,
  } as any);
  return { transactionHash: result.transactionHash as Hex };
}

/** Polls the public RPC until the address's balance reaches minBalance. */
export async function waitForBalance(
  publicClient: PublicClient,
  address: Address,
  minBalance: bigint,
  timeoutMs = 60_000,
  pollIntervalMs = 2_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const balance = await publicClient.getBalance({ address });
    if (balance >= minBalance) return balance;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `Balance for ${address} did not reach ${minBalance} wei within ${timeoutMs}ms`,
  );
}

export type Call = {
  to: Address;
  value?: bigint;
  data?: Hex;
};

export type KeyPermissions = {
  calls?: readonly { signature?: string; to?: Address }[];
  spend?: readonly {
    limit: bigint;
    period: "minute" | "hour" | "day" | "week" | "month" | "year";
    token?: Address;
  }[];
};

export type KeyDescriptor =
  | {
      type: "secp256k1";
      publicKey: Hex;
      role: "admin" | "session";
      expiry?: number;
      permissions?: KeyPermissions;
    }
  | {
      // Passkey (WebAuthnP256) key. Carries the signer so we can rebuild the
      // Porto Key (headless or real credential) when authorizing on-chain.
      type: "webauthn-p256";
      signer: PasskeySigner;
      role: "admin" | "session";
      expiry?: number;
      permissions?: KeyPermissions;
    };

/**
 * Build a KeyDescriptor from a signer, picking the curve variant. Used to
 * authorize a session (or admin) key on-chain; the resulting Porto Key's
 * keyHash must match what signOrder signs under (see sessionKeyHash).
 */
export function keyDescriptorFromSigner(
  signer: Signer,
  opts: {
    role: "admin" | "session";
    expiry?: number;
    permissions?: KeyPermissions;
  },
): KeyDescriptor {
  if (isPasskeySigner(signer)) {
    return {
      type: "webauthn-p256",
      signer,
      role: opts.role,
      ...(opts.expiry !== undefined ? { expiry: opts.expiry } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    };
  }
  return {
    type: "secp256k1",
    publicKey: signer.publicKey,
    role: opts.role,
    ...(opts.expiry !== undefined ? { expiry: opts.expiry } : {}),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  };
}

/**
 * Submits a batch of calls through the relay as a single intent. Returns the
 * calls id; pair with waitForCalls() to wait for inclusion.
 *
 * `submittingKey` is which key signs the intent (admin or session).
 *
 * `authorizeKeys` / `revokeKeys` (optional) bundle key-management ops into
 * the same intent — used by grantSession and revokeSession.
 *
 * This function is the universal choke point for every userOp leaving the
 * SDK. When the admin signs (any flow — execute, grantSession,
 * revokeSession, any future entry point), if the wallet hasn't yet
 * registered its admin authority in KeyStore, we prepend the registration
 * call to this intent. Free batching, automatic, can't be forgotten.
 * Recovery-from-passkey reads from KeyStore, so this guarantee is what
 * makes the recovery feature work for every wallet regardless of what its
 * first action happens to be.
 */
export async function submitCalls(
  client: ReturnType<typeof buildRelayClient>,
  walletAddress: Address,
  signer: Signer,
  calls: readonly Call[],
  opts: {
    feeToken: Address;
    submittingKey: KeyDescriptor;
    authorizeKeys?: readonly KeyDescriptor[];
    revokeKeys?: readonly KeyDescriptor[];
    /**
     * Network is required so we can read KeyStore to decide whether the
     * admin authority needs first-action registration in this intent. Pass
     * the same NetworkConfig you used to build the relay client.
     */
    network: NetworkConfig;
  },
): Promise<Hex> {
  const isAdmin = opts.submittingKey.role === "admin";

  // First-action KeyStore registration. Only admins can register the admin
  // key; session-signed intents never trigger this (a session can't exist
  // without a prior admin action that already would have registered).
  let effectiveCalls: readonly Call[] = calls;
  if (isAdmin) {
    const publicClient = buildPublicClient(opts.network);
    const prepend = await buildFirstActionPrepend({
      publicClient,
      network: opts.network,
      walletAddress,
      adminPublicKey: signer.publicKey,
    });
    if (prepend.length > 0) {
      effectiveCalls = [...prepend, ...calls];
    }
  }

  // Build the signing Porto Key. The descriptor (role + expiry + permissions)
  // must match what the relay stored at key-grant time so the key hash lines
  // up. For admin keys: role only. For session keys: full descriptor.
  let signingKeyForPorto: any;
  // For prepareCalls: admin path passes a viem account object so Porto can
  // resolve the wallet from it; session path passes the wallet address as a
  // string (the wallet's identity is the address; the key authorizing the
  // intent is a separately-authorized session key).
  let accountForPrepare: any;

  if (hasRawPrivateKey(signer)) {
    signingKeyForPorto = Key.fromSecp256k1({
      privateKey: signer._privateKey,
      role: opts.submittingKey.role,
      ...(opts.submittingKey.expiry !== undefined
        ? { expiry: opts.submittingKey.expiry }
        : {}),
      ...(opts.submittingKey.permissions
        ? { permissions: opts.submittingKey.permissions }
        : {}),
    } as any);
    accountForPrepare = isAdmin
      ? privateKeyToAccount(signer._privateKey)
      : walletAddress;
  } else if (isPasskeySigner(signer)) {
    signingKeyForPorto = passkeyToPortoKey(signer, {
      role: opts.submittingKey.role,
      ...(opts.submittingKey.expiry !== undefined
        ? { expiry: opts.submittingKey.expiry }
        : {}),
      ...(opts.submittingKey.permissions
        ? { permissions: opts.submittingKey.permissions }
        : {}),
    });
    // Passkey signers have no EOA, so the wallet identity is always passed
    // by address — both for admin and session paths.
    accountForPrepare = walletAddress;
  } else {
    throw new Error(unsupportedSignerMessage(signer.type, "sign a transaction"));
  }

  const prepareParams: any = {
    account: accountForPrepare,
    calls: effectiveCalls,
    feeToken: opts.feeToken,
  };
  // Tell Porto which key will sign whenever it's not the implicit admin EOA
  // (i.e. session path always, and passkey path always — there's no EOA for
  // Porto to infer from).
  if (!isAdmin || isPasskeySigner(signer)) {
    prepareParams.key = signingKeyForPorto;
  }
  if (opts.authorizeKeys?.length) {
    prepareParams.authorizeKeys = opts.authorizeKeys.map(toPortoKey);
  }
  if (opts.revokeKeys?.length) {
    prepareParams.revokeKeys = opts.revokeKeys.map(toPortoKey);
  }

  const prepared: any = await prepareCalls(client, prepareParams);

  // Porto's signCalls dispatches by `key`: for secp256k1 / webauthn-p256
  // keys with embedded signing material, it calls Key.sign which produces
  // the correctly-wrapped signature. We only need to hand it the key.
  const signature = await signCalls(prepared, {
    key: signingKeyForPorto,
  } as any);

  // For non-EOA paths (sessions, passkey admin), the relay needs to know
  // which key authority signed so it can verify with the right scheme.
  // The privateKey admin path can omit this — Porto infers from the EOA.
  const sendKey =
    !isAdmin || isPasskeySigner(signer) ? signingKeyForPorto : undefined;

  const sent: any = await sendPreparedCalls(client as any, {
    context: prepared.context,
    capabilities: prepared.capabilities,
    signature,
    ...(sendKey ? { key: sendKey } : {}),
  } as any);

  return (sent?.id ?? sent) as Hex;
}

export function toPortoKey(desc: KeyDescriptor): any {
  if (desc.type === "webauthn-p256") {
    return passkeyToPortoKey(desc.signer, {
      role: desc.role,
      ...(desc.expiry !== undefined ? { expiry: desc.expiry } : {}),
      ...(desc.permissions ? { permissions: desc.permissions } : {}),
    });
  }
  return Key.fromSecp256k1({
    publicKey: desc.publicKey,
    role: desc.role,
    ...(desc.expiry !== undefined ? { expiry: desc.expiry } : {}),
    ...(desc.permissions ? { permissions: desc.permissions } : {}),
  } as any);
}

/**
 * Produce a guidance-shaped error message for an unsupported signer type.
 * The goal: a developer reading this in their stack trace knows exactly which
 * API to call instead, without digging into our source.
 */
function unsupportedSignerMessage(type: string, doing: string): string {
  const options =
    `  • signerFromPrivateKey(privateKey)   — existing private key\n` +
    `  • createPrivateKeySigner()           — fresh SDK-generated key\n` +
    `  • createPasskey({ name })            — WebAuthn passkey (browser)\n` +
    `  • createHeadlessPasskey()            — P256 passkey for Node/tests`;
  if (type === "injected") {
    return (
      `Injected wallet signers (e.g. MetaMask) need to ${doing} but the ` +
      `current build of @altananetwork/sdk doesn't accept them as a signer ` +
      `type. Use one of the supported entry points:\n${options}`
    );
  }
  return (
    `Got a signer with type "${type}". @altananetwork/sdk expects a signer ` +
    `built from one of:\n${options}`
  );
}

/** One event log as the relay reports it inside a status receipt. */
export type RelayLog = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
};

/** One transaction receipt from `wallet_getCallsStatus`. */
export type RelayReceipt = {
  transactionHash?: Hex;
  status?: Hex | number;
  logs?: readonly RelayLog[];
};

/**
 * Polls the relay for the status of a submitted calls bundle.
 *
 * The status response carries full receipts, logs included. Callers that need
 * to recover a value the contract only emitted (an ERC-721 token id, say) read
 * them from here rather than re-fetching the receipt from a public RPC: BSC's
 * public endpoints serve stale reads for ~12s after the relay reports
 * CONFIRMED (see grantSession's post-confirm wait), so a follow-up read is
 * both slower and less reliable than the receipt we already have in hand.
 */
export async function waitForCalls(
  client: ReturnType<typeof buildRelayClient>,
  callsId: Hex,
  timeoutMs = 240_000,
  pollIntervalMs = 2_000,
): Promise<{
  status: string;
  transactionHash?: Hex;
  receipts?: readonly RelayReceipt[];
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status: any = await getCallsStatus(client as any, { id: callsId });
      const code = status?.status;
      if (code === 200 || code === "CONFIRMED") {
        return {
          status: "CONFIRMED",
          transactionHash: status?.receipts?.[0]?.transactionHash,
          ...(status?.receipts ? { receipts: status.receipts as readonly RelayReceipt[] } : {}),
        };
      }
      if (code === 500 || code === "FAILED") {
        return {
          status: "FAILED",
          ...(status?.receipts ? { receipts: status.receipts as readonly RelayReceipt[] } : {}),
        };
      }
    } catch {
      // Transient relay errors — keep polling.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { status: "PENDING" };
}
