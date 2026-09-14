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
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NATIVE_TOKEN, type NetworkConfig } from "../config.js";
import { feeTokenHint } from "./feeCurrencies.js";
import { resolveFeeToken, type FeeTokenOption } from "./feeTokenSelection.js";
import { hasRawPrivateKey, type Signer } from "./signer.js";
import {
  isPasskeySigner,
  passkeyToPortoKey,
  type PasskeySigner,
} from "./passkey.js";
import { buildFirstActionPrepend } from "./keystore.js";

/** Faucet for Celo Sepolia (chainId 11142220). */
export const CELO_SEPOLIA_FAUCET_URL = "https://faucet.celo.org/celo-sepolia";
/** Faucet for BNB Smart Chain testnet (chainId 97). */
export const BNB_TESTNET_FAUCET_URL = "https://testnet.bnbchain.org/faucet-smart";
/** Faucet for Sepolia (chainId 11155111), the registry chain behind Celo Sepolia. */
export const SEPOLIA_FAUCET_URL =
  "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";

/** Test-network faucets by chainId. Mainnets have none. */
export const FAUCET_URLS: Readonly<Record<number, string>> = {
  97: BNB_TESTNET_FAUCET_URL,
  11142220: CELO_SEPOLIA_FAUCET_URL,
  11155111: SEPOLIA_FAUCET_URL,
};

/** The faucet URL for a test chain, or undefined for chains without one. */
export function faucetHint(chainId: number): string | undefined {
  return FAUCET_URLS[chainId];
}

/**
 * True when the network's KeyStore lives on another chain behind a local
 * cache. Null-safe: the signer gate in submitCalls must fire before any
 * network lookup, and some callers pass no network to reach it.
 */
function isCachedNetwork(network: NetworkConfig | null | undefined): boolean {
  return network?.registry?.kind === "cached";
}

export function buildRelayClient(network: NetworkConfig) {
  if (!network.relayUrl) {
    throw new Error(
      `No Altana relay serves chain ${network.chainId} (${network.chain.name}). ` +
        `The testnet relay serves BSC testnet (97), Sepolia (11155111), Celo Sepolia (11142220) ` +
        `and Base Sepolia (84532); keystore-only networks cannot execute through a relay.`,
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

    const prepared: any = await withRelayChainCheck(client, () =>
      prepareUpgradeAccount(client, {
        address: account.address,
        authorizeKeys: [adminKey],
      }),
    );

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

    const prepared: any = await withRelayChainCheck(client, () =>
      prepareUpgradeAccount(client, {
        address: throwawayAccount.address,
        authorizeKeys: [passkeyAdminKey],
      }),
    );

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

/**
 * The message for a relay that answers but has no capabilities entry for the
 * client's chain: porto surfaces that as an opaque TypeError while
 * destructuring the missing entry. Seen when a chain is configured ahead of
 * the relay redeploy that serves it (Celo Sepolia before the testnet relay
 * added chain 11142220).
 */
export function relayDoesNotServeChainMessage(chainId: number, relayUrl?: string): string {
  return (
    `The Altana relay${relayUrl ? ` at ${relayUrl}` : ""} does not serve chain ${chainId} ` +
    `(its wallet_getCapabilities has no entry for it). The chain is configured in the SDK ` +
    `ahead of the relay: wait for the relay deployment that adds it, or point relayUrl at a ` +
    `relay that lists chain ${chainId}.`
  );
}

/** True when `err` is porto's failure mode for a chain the relay does not list. */
export function isMissingRelayChainError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /Cannot destructure property 'contracts'/.test(text);
}

async function withRelayChainCheck<T>(
  client: ReturnType<typeof buildRelayClient>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingRelayChainError(err)) throw err;
    const chainId = client.chain?.id ?? 0;
    const url = (client.transport as { url?: string }).url;
    throw new Error(relayDoesNotServeChainMessage(chainId, url), { cause: err });
  }
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
  opts: SubmitCallsOptions,
): Promise<Hex> {
  const { callsId } = await submitCallsDetailed(client, walletAddress, signer, calls, opts);
  return callsId;
}

export type SubmitCallsOptions = {
  /**
   * The token to pay the relay fee in: one address to force it, or a list to
   * pay with the first the relay accepts and the wallet holds. Omitted, a
   * wallet key names none and the relay charges whichever accepted token the
   * wallet holds; a session key names the token of its spend cap the wallet
   * holds the most of. See `resolveFeeToken`.
   */
  feeToken?: FeeTokenOption;
  submittingKey: KeyDescriptor;
  authorizeKeys?: readonly KeyDescriptor[];
  revokeKeys?: readonly KeyDescriptor[];
  /**
   * Network is required so we can read KeyStore to decide whether the
   * admin authority needs first-action registration in this intent. Pass
   * the same NetworkConfig you used to build the relay client.
   */
  network: NetworkConfig;
};

/** What `submitCalls` learned from the relay's quote, beyond the calls id. */
export type SubmitCallsResult = {
  callsId: Hex;
  /** The token the relay is charging its fee in, from the quoted intent. */
  feeToken?: Address;
};

/**
 * The `wallet_prepareCalls` parameters for a set of calls. `feeToken` is only
 * sent when the caller named one, so the relay picks otherwise.
 */
export function buildPrepareParams(args: {
  account: unknown;
  calls: readonly Call[];
  feeToken?: Address;
}): { account: unknown; calls: readonly Call[]; feeToken?: Address } {
  return {
    account: args.account,
    calls: args.calls,
    ...(args.feeToken ? { feeToken: args.feeToken } : {}),
  };
}

/**
 * The fee token of a prepared intent, read from the quote the relay signed:
 * `context.quote.quotes[0].intent.paymentToken`. Undefined when the answer
 * carries no quote (a pre-call, for instance).
 */
export function paymentTokenFromPrepared(prepared: unknown): Address | undefined {
  const quotes = (prepared as { context?: { quote?: { quotes?: unknown } } })?.context?.quote
    ?.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) return undefined;
  const token = (quotes[0] as { intent?: { paymentToken?: unknown } })?.intent?.paymentToken;
  return typeof token === "string" && /^0x[0-9a-fA-F]{40}$/.test(token)
    ? getAddress(token)
    : undefined;
}

/** `submitCalls`, also reporting which token the relay charged. */
export async function submitCallsDetailed(
  client: ReturnType<typeof buildRelayClient>,
  walletAddress: Address,
  signer: Signer,
  calls: readonly Call[],
  opts: SubmitCallsOptions,
): Promise<SubmitCallsResult> {
  const { prepared, signingKeyForPorto, isAdmin } = await prepareIntent(
    client,
    walletAddress,
    signer,
    calls,
    opts,
  );
  const feeToken = paymentTokenFromPrepared(prepared);

  // Porto's signCalls dispatches by `key`: for secp256k1 / webauthn-p256
  // keys with embedded signing material, it calls Key.sign which produces
  // the correctly-wrapped signature. We only need to hand it the key —
  // except when the signer carries custom WebAuthn functions (React Native
  // etc.), which signCalls cannot forward; signPreparedCalls handles that.
  const customWebAuthn =
    isPasskeySigner(signer) && signer.webAuthn?.getFn
      ? { getFn: signer.webAuthn.getFn }
      : undefined;
  const signature = customWebAuthn
    ? await signPreparedCalls(prepared, signingKeyForPorto, customWebAuthn)
    : await signCalls(prepared, {
        key: signingKeyForPorto,
      } as any);

  // For non-EOA paths (sessions, passkey admin), the relay needs to know
  // which key authority signed so it can verify with the right scheme.
  // The privateKey admin path can omit this — Porto infers from the EOA.
  const sendKey =
    !isAdmin || isPasskeySigner(signer) ? signingKeyForPorto : undefined;

  const sent: any = await withRelayReason(
    () =>
      sendPreparedCalls(client as any, {
        context: prepared.context,
        capabilities: prepared.capabilities,
        signature,
        ...(sendKey ? { key: sendKey } : {}),
      } as any),
    "submit the call",
    { client, network: opts.network },
  );

  return { callsId: (sent?.id ?? sent) as Hex, ...(feeToken ? { feeToken } : {}) };
}

/** What the relay would charge for an intent, without signing or sending it. */
export type CallsQuote = {
  /** Maximum fee the intent pays, in `feeToken` base units, summed over the relay's quotes. */
  fee: bigint;
  /** The token the relay is charging its fee in (the zero address is native). */
  feeToken: Address;
  /** Native value the intent's calls carry (registration fees), first-action prepend included. */
  value: bigint;
  /** How much fee token the payer is missing, as the relay reports it. 0 when funded. */
  feeTokenDeficit: bigint;
  /**
   * Native wei the wallet needs for this intent: the fee (when paid in the native token) plus the
   * value the calls carry, such as a registration fee. When the wallet is short, the relay's own
   * figure for the native token (its asset deficit `required`) is used instead.
   */
  nativeNeeded: bigint;
  /** True when `nativeNeeded` is the relay's own figure rather than fee plus value. */
  nativeNeededFromRelay: boolean;
};

/**
 * Quotes an intent: the same preparation as submitCalls (first-action
 * prepend, key descriptors, registry-target guard), then the relay's quote,
 * with nothing signed or sent. For a passkey admin this does not prompt.
 */
export async function quoteCalls(
  client: ReturnType<typeof buildRelayClient>,
  walletAddress: Address,
  signer: Signer,
  calls: readonly Call[],
  opts: SubmitCallsOptions,
): Promise<CallsQuote> {
  const { prepared, effectiveCalls, feeToken: named } = await prepareIntent(client, walletAddress, signer, calls, opts);
  const { fee, feeTokenDeficit } = feeFromPrepared(prepared);
  const value = effectiveCalls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  // The token the relay quoted in; the one the rule named when the quote does not say.
  const feeToken = paymentTokenFromPrepared(prepared) ?? named ?? NATIVE_TOKEN;
  return {
    fee,
    feeTokenDeficit,
    feeToken,
    value,
    ...nativeNeededFromPrepared(prepared, { fee, value, feeToken }),
  };
}

/**
 * Native wei an intent needs from the wallet. The relay only states a balance figure when the
 * wallet is short: then each quote carries an asset deficit for the native token whose
 * `required` covers the fee and everything the intent spends. Otherwise the need is the fee (if
 * paid natively) plus the value the calls carry.
 */
export function nativeNeededFromPrepared(
  prepared: any,
  args: { fee: bigint; value: bigint; feeToken: Address },
): { nativeNeeded: bigint; nativeNeededFromRelay: boolean } {
  const estimate = args.value + (args.feeToken.toLowerCase() === NATIVE_TOKEN ? args.fee : 0n);
  const quotes: any[] = prepared?.context?.quote?.quotes ?? [];
  let fromRelay = 0n;
  let reported = false;
  for (const q of quotes) {
    for (const d of (q?.assetDeficits ?? []) as any[]) {
      const native = d?.address === null || d?.address === undefined || String(d.address).toLowerCase() === NATIVE_TOKEN;
      if (!native) continue;
      fromRelay += toBigInt(d.required);
      reported = true;
    }
  }
  if (reported && fromRelay >= estimate) return { nativeNeeded: fromRelay, nativeNeededFromRelay: true };
  return { nativeNeeded: estimate, nativeNeededFromRelay: false };
}

/** Reads the fee out of a prepareCalls response (porto decodes the quote's hex amounts). */
export function feeFromPrepared(prepared: any): { fee: bigint; feeTokenDeficit: bigint } {
  const quotes: any[] = prepared?.context?.quote?.quotes ?? [];
  if (quotes.length === 0) {
    throw new Error("The relay's prepareCalls response carried no quote to read a fee from.");
  }
  let fee = 0n;
  let feeTokenDeficit = 0n;
  for (const q of quotes) {
    fee += toBigInt(q?.intent?.totalPaymentMaxAmount);
    feeTokenDeficit += toBigInt(q?.feeTokenDeficit);
  }
  return { fee, feeTokenDeficit };
}

function toBigInt(x: unknown): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  if (typeof x === "string" && x.length > 0) return BigInt(x);
  return 0n;
}

async function prepareIntent(
  client: ReturnType<typeof buildRelayClient>,
  walletAddress: Address,
  signer: Signer,
  calls: readonly Call[],
  opts: SubmitCallsOptions,
): Promise<{
  prepared: any;
  signingKeyForPorto: any;
  isAdmin: boolean;
  effectiveCalls: readonly Call[];
  /** The fee token named in the request, if the fee token rule named one. */
  feeToken: Address | undefined;
}> {
  const isAdmin = opts.submittingKey.role === "admin";

  // On a cached network (Celo Sepolia, Celo) the KeyStore contracts do not
  // exist at network.keyStore / keyStoreController on this chain: those are
  // the registry chain's addresses. A call aimed at them here would not
  // revert, it would land as a plain transfer to a codeless address, so a
  // registerKey carrying the registration fee would burn that fee. Refuse it
  // before anything reaches the relay.
  assertNoRegistryTargets(opts.network, calls);

  // First-action KeyStore registration. Only admins can register the admin
  // key; session-signed intents never trigger this (a session can't exist
  // without a prior admin action that already would have registered). On a
  // cached network the registry lives on another chain, so the prepend is
  // skipped here: the admin registers lazily on the registry chain inside the
  // wallet's first registry write (see submitRegistryCalls).
  let effectiveCalls: readonly Call[] = calls;
  if (needsFirstActionPrepend(opts.network, opts.submittingKey.role)) {
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

  // Decided here, before the request is built: porto fills a blank fee token
  // from a session key's first spend cap, which the relay may not accept.
  const chosenFeeToken = await resolveFeeToken({
    relay: client,
    network: opts.network,
    walletAddress,
    ...(opts.feeToken ? { feeToken: opts.feeToken } : {}),
    submittingKey: {
      role: opts.submittingKey.role,
      ...(opts.submittingKey.permissions ? { permissions: opts.submittingKey.permissions } : {}),
    },
  });
  const prepareParams: any = buildPrepareParams({
    account: accountForPrepare,
    calls: effectiveCalls,
    ...(chosenFeeToken ? { feeToken: chosenFeeToken } : {}),
  });
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

  const prepared: any = await withRelayReason(
    () => prepareCalls(client, prepareParams),
    "prepare the call",
    { client, network: opts.network },
  );

  return { prepared, signingKeyForPorto, isAdmin, effectiveCalls, feeToken: chosenFeeToken };
}

/**
 * Whether an intent signed by `role` on `network` must carry the admin's
 * first-action KeyStore registration: admins on networks whose KeyStore is
 * local. Cached networks register on their registry chain instead.
 */
export function needsFirstActionPrepend(
  network: NetworkConfig,
  role: "admin" | "session",
): boolean {
  return role === "admin" && !isCachedNetwork(network);
}

/**
 * Refuses, on a cached network, any call whose target is the registry
 * chain's KeyStore or Controller address. Those contracts are not deployed on
 * the cached network, so the call would confirm as a plain native transfer
 * to a codeless address and burn whatever value it carried (a registration
 * fee, typically). Registry writes belong on the registry chain: grantSession
 * and revokeSession route them there automatically.
 */
export function assertNoRegistryTargets(
  network: NetworkConfig,
  calls: readonly Call[],
): void {
  if (!isCachedNetwork(network)) return;
  const registry = network.registry?.kind === "cached" ? network.registry.l1 : network;
  const forbidden = new Map<string, string>([
    [network.keyStore.toLowerCase(), "KeyStore"],
    [network.keyStoreController.toLowerCase(), "KeyStoreController"],
  ]);
  for (const call of calls) {
    const label = forbidden.get(call.to.toLowerCase());
    if (!label) continue;
    throw new Error(
      `Refusing to send a call to ${call.to} on ${network.chain.name} (chainId ` +
        `${network.chainId}): that is the ${label} address of ${registry.chain.name} ` +
        `(chainId ${registry.chainId}), where this network's KeyStore registry lives. ` +
        `No contract exists at it on ${network.chain.name}, so the call would confirm as ` +
        `a plain transfer to a codeless address and burn its value` +
        (call.value ? ` (${call.value} wei here)` : "") +
        `. Registry writes go to ${registry.chain.name}: use grantSession, revokeSession ` +
        `or registerSessionKey, which route them there.`,
    );
  }
}

/**
 * The relay explains rejections precisely ("fee token not supported: 0x…",
 * "quote expired", …), but that message rides several `.cause` levels below
 * viem's generic wrapper ("Invalid parameters were provided to the RPC
 * method"), where nobody finds it. Run a relay call through this so the real
 * reason leads the thrown error; the original is kept as `cause`.
 */
async function withRelayReason<T>(
  fn: () => Promise<T>,
  doing: string,
  relay?: { client: ReturnType<typeof buildRelayClient>; network: NetworkConfig },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const reason = deepestRelayReason(err);
    if (!reason) throw err;
    // A fee token rejection names the tokens this relay does accept, read live.
    const hint =
      /fee token/i.test(reason) && relay ? await feeTokenHint(relay.client, relay.network) : "";
    throw new Error(`The relay rejected the request to ${doing}: ${reason}${hint}`, { cause: err });
  }
}

/** Generic wrapper strings viem/porto layer on top of the real relay message. */
const GENERIC_ERROR_TEXT = [
  "Invalid parameters were provided to the RPC method",
  "RPC Request failed",
  "An error occurred while executing calls",
  "HTTP request failed",
  "Double check you have provided the correct parameters",
];

/**
 * Walk an error's `cause` chain and pull out the most specific relay message:
 * the deepest `details`/`message` that isn't one of viem's generic wrappers.
 */
export function deepestRelayReason(err: unknown): string | undefined {
  let best: string | undefined;
  let cur: any = err;
  for (let i = 0; i < 12 && cur && typeof cur === "object"; i++) {
    for (const raw of [cur.details, cur.shortMessage, cur.message]) {
      const text = typeof raw === "string" ? raw.split("\n")[0]!.trim() : "";
      if (text && !GENERIC_ERROR_TEXT.some((g) => text.includes(g))) best = text;
    }
    cur = cur.cause;
  }
  return best;
}

/**
 * Sign a prepared calls bundle with explicit WebAuthn function overrides.
 *
 * A faithful inline of the `key` arm of porto's `RelayActions.signCalls`
 * (porto 0.2.37, src/viem/RelayActions.ts:618-643): the digest is
 * `prepared.digest`, `wrap` mirrors `Boolean(context.preCall)`, and the
 * return value is the bare signature `sendPreparedCalls` expects. We inline
 * it because signCalls does not forward `webAuthn` options to `Key.sign`,
 * and a signer running outside a browser (React Native) must supply its
 * own `getFn`. Re-check the inline against RelayActions.signCalls on any
 * porto version bump. Headless webauthn keys embed their private key and
 * sign locally — Key.sign ignores `webAuthn` for them, so routing them
 * here is harmless.
 */
export async function signPreparedCalls(
  prepared: any,
  key: any,
  webAuthn: { getFn: NonNullable<Key.sign.Parameters["webAuthn"]>["getFn"] },
): Promise<Hex> {
  return (await Key.sign(key, {
    address: null,
    payload: prepared.digest,
    wrap: Boolean(prepared.context?.preCall),
    webAuthn,
  } as any)) as Hex;
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
 *
 * Status codes follow the EIP-5792 bands (neither porto nor the relay
 * enumerates them; viem classifies identically): 1xx still in flight,
 * 2xx success, 300–699 terminal failure — 300 is the relay rejecting the
 * bundle before inclusion (fee unpayable under the session's spend cap,
 * relay policy), 5xx an on-chain revert, 6xx partial failure. A code
 * outside every band keeps polling rather than guessing: FAILED is the
 * caller's "terminal, safe to resubmit" signal, and misreading an unknown
 * code as terminal risks a duplicate submission. The raw code is returned
 * as `statusCode` whenever one was observed — including on a timed-out
 * PENDING, where its absence means the relay never answered at all.
 */
export async function waitForCalls(
  client: ReturnType<typeof buildRelayClient>,
  callsId: Hex,
  timeoutMs = 240_000,
  pollIntervalMs = 2_000,
): Promise<{
  status: string;
  statusCode?: number;
  transactionHash?: Hex;
  receipts?: readonly RelayReceipt[];
}> {
  const deadline = Date.now() + timeoutMs;
  let lastCode: number | undefined;
  while (Date.now() < deadline) {
    try {
      const status: any = await getCallsStatus(client as any, { id: callsId });
      const code = status?.status;
      if (typeof code === "number") lastCode = code;
      if ((typeof code === "number" && code >= 200 && code < 300) || code === "CONFIRMED") {
        return {
          status: "CONFIRMED",
          ...(typeof code === "number" ? { statusCode: code } : {}),
          transactionHash: status?.receipts?.[0]?.transactionHash,
          ...(status?.receipts ? { receipts: status.receipts as readonly RelayReceipt[] } : {}),
        };
      }
      if ((typeof code === "number" && code >= 300 && code < 700) || code === "FAILED") {
        return {
          status: "FAILED",
          ...(typeof code === "number" ? { statusCode: code } : {}),
          ...(status?.receipts ? { receipts: status.receipts as readonly RelayReceipt[] } : {}),
        };
      }
      // 1xx (and anything out-of-band): still in flight — keep polling.
    } catch {
      // Transient relay errors — keep polling.
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { status: "PENDING", ...(lastCode !== undefined ? { statusCode: lastCode } : {}) };
}
