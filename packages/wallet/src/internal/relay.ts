/**
 * Relay layer. Wraps the upstream relay provider so the public API never
 * imports it directly.
 */

import {
  prepareUpgradeAccount,
  upgradeAccount,
  prepareCalls,
  signCalls,
  sendPreparedCalls,
  getCallsStatus,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import {
  createClient,
  createPublicClient,
  decodeErrorResult,
  fallback,
  formatUnits,
  getAddress,
  hexToBigInt,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { NATIVE_TOKEN, networkByChainId, registryNetwork, type NetworkConfig } from "../config.js";
import { stripEip7708AssetDiffs } from "./eip7708.js";
import { acceptedFeeSymbols, acceptedFeeTokens, feeTokenHint } from "./feeCurrencies.js";
import { explainRelayFailure, classifyRelayFailure, type FundingShortfall, type RelayFailureFacts } from "../errors.js";
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
    transport: sanitizingHttp(network.relayUrl),
  });
}

/**
 * The relay transport, with EIP-7708 system-address asset diffs removed before
 * porto sees them.
 *
 * Every relay call in the SDK goes through `buildRelayClient`, and the client
 * it returns is what is handed to `porto/viem/RelayActions`, so porto
 * validates whatever this transport returns. Sanitising in the transport is
 * therefore strictly before porto's schema check — which is the only place it
 * can go, since porto rejects the whole response and never hands it back.
 * See `eip7708.ts` for why the entries are dropped rather than relabelled.
 */
function sanitizingHttp(url: string): Transport {
  const inner = http(url, { timeout: 60_000 });
  return (params) => {
    const transport = inner(params);
    return {
      ...transport,
      request: async (args: Parameters<typeof transport.request>[0]) =>
        stripEip7708AssetDiffs(await transport.request(args)),
    };
  };
}

export function buildPublicClient(network: NetworkConfig): PublicClient {
  return createPublicClient({
    chain: network.chain,
    transport: http(network.publicRpcUrl),
  });
}

/**
 * The client a KeyStoreCache proof is built with: `eth_getProof` and the
 * header fetch at the block the L2 anchors. Uses the network's
 * `proofRpcUrls` in order, then `publicRpcUrl`, moving to the next endpoint
 * when one refuses the block. A network without `proofRpcUrls` gets the same
 * client as `buildPublicClient`.
 */
export function buildProofClient(network: NetworkConfig): PublicClient {
  const urls = network.proofRpcUrls ?? [];
  if (urls.length === 0) return buildPublicClient(network);
  return createPublicClient({
    chain: network.chain,
    transport: fallback([...urls, network.publicRpcUrl].map((url) => http(url))),
  });
}

/**
 * How a wallet is provisioned, decided once and used on every chain.
 *
 * A wallet is one address, so the EIP-7702 authorization on every chain is
 * signed by the same secp256k1 key over that one address:
 *
 *  - privateKey signers: the signer's own EOA is the wallet address, and the
 *    signer signs the authorization directly.
 *  - passkey signers: setCode needs a secp256k1 signature on the
 *    authorization tuple and a passkey is P256, so one throwaway secp256k1
 *    stands in. It signs every chain's authorization with the passkey listed
 *    as `authorizeKeys`, and is discarded when provisioning returns, leaving
 *    the passkey as the account's only authority. The wallet address is the
 *    throwaway's EOA address.
 *
 * The plan is built once per wallet, never per chain: a throwaway generated
 * per chain would give the wallet a different address on each one.
 */
export type ProvisioningPlan = {
  /** The wallet's address, the same on every chain. */
  walletAddress: Address;
  /** Keys the account authorizes at creation, as porto keys. */
  authorizeKeys: readonly unknown[];
  /** Signs each chain's authorization digest, as the owner of `walletAddress`. */
  signDigest: (digest: Hex) => Promise<Hex>;
};

/** The provisioning plan for a signer: its wallet address and who signs the upgrade. */
export function planAccountProvisioning(signer: Signer): ProvisioningPlan {
  if (hasRawPrivateKey(signer)) {
    const account = privateKeyToAccount(signer._privateKey);
    return {
      walletAddress: account.address,
      authorizeKeys: [Key.fromSecp256k1({ privateKey: signer._privateKey, role: "admin" })],
      signDigest: (digest) => signer.signDigest(digest),
    };
  }

  if (isPasskeySigner(signer)) {
    const throwaway = privateKeyToAccount(generatePrivateKey());
    return {
      walletAddress: throwaway.address,
      authorizeKeys: [passkeyToPortoKey(signer, { role: "admin" })],
      signDigest: (digest) => throwaway.sign({ hash: digest }),
    };
  }

  throw new Error(unsupportedSignerMessage(signer.type, "create a wallet"));
}

/**
 * Registers a planned account with one chain's relay. Counterfactual: no
 * on-chain action, the setCode lands as a preCall on that chain's first
 * execute. Call it once per chain with the same plan.
 */
export async function provisionAccount(
  client: ReturnType<typeof buildRelayClient>,
  plan: ProvisioningPlan,
): Promise<void> {
  const prepared: any = await withRelayChainCheck(client, () =>
    prepareUpgradeAccount(client, {
      address: plan.walletAddress,
      authorizeKeys: plan.authorizeKeys as never,
    }),
  );

  const signatures: Record<string, Hex> = {};
  for (const [name, digest] of Object.entries(prepared.digests ?? {})) {
    signatures[name] = await plan.signDigest(digest as Hex);
  }

  await upgradeAccount(client as any, {
    context: prepared.context,
    signatures,
  } as any);
}

/** Plan and provision on one chain, for callers that need no more than that. */
export async function registerAccount(
  client: ReturnType<typeof buildRelayClient>,
  signer: Signer,
): Promise<{ walletAddress: Address }> {
  const plan = planAccountProvisioning(signer);
  await provisionAccount(client, plan);
  return { walletAddress: plan.walletAddress };
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

/**
 * @deprecated Always throws. The relay's faucet only mints ERC-20 fee tokens
 * (`wallet_addFaucetFunds` sends `mint(recipient, value)` calldata); a native
 * request produced a zero-value transaction to `0x0` and this helper returned
 * its hash as if the wallet had been funded. Fund the address from the chain's
 * public faucet ({@link faucetHint}) and poll with `waitForBalance`. Will be
 * removed in a later release.
 */
export async function fundNative(
  client: ReturnType<typeof buildRelayClient>,
  address: Address,
  _amount: bigint,
): Promise<{ transactionHash: Hex }> {
  const faucet = faucetHint(client.chain?.id ?? 0);
  throw new Error(
    `fundNative: the relay cannot fund native currency (its faucet only mints ERC-20 test tokens; a native ` +
      `request sends nothing). Send native currency to ${address} yourself` +
      (faucet ? ` from ${faucet}` : "") +
      `, then wait with waitForBalance.`,
  );
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
  /**
   * Funds the intent must have on this chain that the wallet lacks. The relay
   * locks the same asset on another chain the wallet holds it on, fronts it
   * here, and settles, under one signature. Used for registry writes funded
   * from an L2 balance.
   */
  requiredFunds?: readonly RequiredFund[];
  /**
   * Skips this intent's first-action KeyStore registration.
   *
   * Set only by `submitRegistryWrite` when the calls it passes ARE that
   * registration: a first-time registry write is two sequential intents, and
   * the first one carries `initialRegisterKey` itself. Without this, the
   * prepend fires on that intent too and registers the admin key twice in one
   * intent, paying the fee twice.
   */
  skipFirstActionPrepend?: boolean;
  /**
   * The nonce for this intent, when the caller is choosing it.
   *
   * Set only by `execute` for an app transaction, which runs on a lane of the
   * SDK's own (`appNonceLane.ts`). Every other intent leaves it unset so the
   * relay keeps choosing from lane 0 -- including the grant's account legs, the
   * registry write and the cache proof, none of which the caller fires and all
   * of which the relay already sequences for itself.
   */
  nonce?: bigint;
  /**
   * What the person is doing, in their words: "registering this key on
   * Ethereum", "this transfer". Used only to word a failure, and only ever
   * read by the error map; the SDK's own "prepare the call" is for logs.
   */
  operation?: string;
  /**
   * The chain the payer pays from, when it is not the chain the intent runs
   * on. A registry write on Ethereum funded from a Celo balance sets it to
   * Celo, and that is the only chain a failure may name: the wallet holding
   * no ETH on Ethereum is what the product is for, not a fault to report.
   */
  fundFrom?: NetworkConfig;
  /**
   * What the caller's own quote said this costs the payer, on `fundFrom` (or
   * on this chain when there is none). The relay will not quote for a wallet
   * it has already refused, so a figure in the payer's own token exists on a
   * failure only when a quote was taken before it.
   */
  expectedCost?: { chainId: number; token: Address; amount: bigint };
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
  requiredFunds?: readonly RequiredFund[];
  /**
   * The intent's nonce, when the caller is choosing it. Porto passes it to the
   * relay as `capabilities.meta.nonce`, which the relay uses verbatim. Omitted,
   * the relay reads the account's lane-0 nonce itself, which is the behaviour
   * every intent except an app transaction still wants.
   */
  nonce?: bigint;
}): {
  account: unknown;
  calls: readonly Call[];
  feeToken?: Address;
  requiredFunds?: readonly RequiredFund[];
  nonce?: bigint;
} {
  return {
    account: args.account,
    calls: args.calls,
    ...(args.feeToken ? { feeToken: args.feeToken } : {}),
    ...(args.requiredFunds?.length ? { requiredFunds: args.requiredFunds } : {}),
    ...(args.nonce !== undefined ? { nonce: args.nonce } : {}),
  };
}

/** An asset the relay must make available on the intent's chain (zero address = native). */
export type RequiredFund = { address: Address; value: bigint };

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
  const { prepared, signingKeyForPorto, isAdmin, effectiveCalls } = await prepareIntent(
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
    intentContext(walletAddress, effectiveCalls, feeToken, opts),
  );

  return { callsId: (sent?.id ?? sent) as Hex, ...(feeToken ? { feeToken } : {}) };
}

/** What the relay would charge for an intent, without signing or sending it. */
/** One leg of a quoted bundle: the relay quotes one per chain it will touch. */
export type QuoteLeg = {
  chainId?: number;
  /** The gas budget for THIS leg, as signed. Compare a leg's need against this. */
  combinedGas?: bigint;
};

export type CallsQuote = {
  /** Set when the relay quoted a second chain to fund this intent from: that chain. */
  fundedFromChainId?: number;
  /**
   * The gas budget the relay quoted, one entry per leg.
   *
   * This is what decides whether an intent fits: the relay bounds execution by
   * it, and a call sequence needing more runs out of gas and reverts with no
   * reason, which the Orchestrator reports as `CallError()` — naming neither
   * gas nor the call. On 2026-10-07 that cost three escrowed runs and five
   * revisions of the relay's intent buffer to establish a number the quote
   * already contained.
   *
   * Deliberately not reduced to a scalar. There is no correct scalar: each leg
   * carries its own buffer and is checked against its own budget, so "does this
   * fit" is a per-leg question. Empty when the relay's quote carried no legs.
   */
  legs: readonly QuoteLeg[];
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
  /**
   * What each quoted leg charges, in that leg's own token on its own chain.
   *
   * `fee` above is a single number and only means one when every leg charges
   * the same token. A cross-asset quote charges the source leg in CELO or a
   * stablecoin and the destination leg in ETH, so read this to show or check
   * either one. Empty when the relay's quote carried no legs.
   */
  charges: readonly LegCharge[];
  /**
   * What the payer must hold for this intent, per chain and token.
   *
   * This is the figure to check a balance against. For a multichain quote it
   * is the source chain's own cost only: the escrow the wallet locks there
   * plus that leg's fee. The destination chain costs the payer nothing — the
   * funder fronts it and the escrow repays it — so no need is reported there.
   */
  needs: readonly QuoteNeed[];
};

/** What one quoted leg charges its payer, in that leg's own token on its own chain. */
export type LegCharge = {
  /** The leg's chain. Absent when the relay's quote did not name one. */
  chainId?: number;
  /** The token the relay charges this leg's fee in (the zero address is native). */
  feeToken: Address;
  /** The leg's own fee, in `feeToken` base units. Never summed across legs. */
  fee: bigint;
  /** How much of `feeToken` the payer is missing on this leg. 0 when funded. */
  feeTokenDeficit: bigint;
};

/** One amount the payer must hold: a token on a chain. */
export type QuoteNeed = {
  /** The chain the amount is needed on. Absent when the quote named no chain. */
  chainId?: number;
  /** The token needed (the zero address is that chain's native token). */
  token: Address;
  /** The amount, in that token's own base units. */
  amount: bigint;
  /** True when the amount is the relay's own asset-deficit figure. */
  fromRelay: boolean;
  /** The token's symbol, when the relay's asset diffs named one. */
  symbol?: string;
  /** The token's decimals, when the relay's asset diffs named them. */
  decimals?: number;
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
  const value = effectiveCalls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
  const ownChainId = client.chain?.id;
  const fundedFromChainId = fundedFromChainIdOf(prepared, ownChainId);
  // The chain whose balance this costs the payer: the funding chain of a
  // multichain quote, the intent's own chain otherwise.
  const payChainId = fundedFromChainId ?? ownChainId;
  const { fee, feeTokenDeficit, feeToken: quoted, charges } = feeFromPrepared(prepared, { payChainId });
  // The token the relay quoted in; the one the rule named when the quote does not say.
  const feeToken = quoted ?? named ?? NATIVE_TOKEN;
  return {
    ...(fundedFromChainId !== undefined ? { fundedFromChainId } : {}),
    legs: quoteLegsFromPrepared(prepared),
    fee,
    feeTokenDeficit,
    feeToken,
    value,
    charges,
    ...nativeNeededFromPrepared(prepared, {
      fee,
      value,
      feeToken,
      charges,
      payer: walletAddress,
      ...(ownChainId !== undefined ? { ownChainId } : {}),
      ...(payChainId !== undefined ? { payChainId } : {}),
    }),
  };
}

/**
 * The chain a multichain quote sources funds from: the quote whose chain is
 * not the intent's own, present only when the relay signed a multichain root.
 */
export function fundedFromChainIdOf(prepared: any, ownChainId: number | undefined): number | undefined {
  const quote = prepared?.context?.quote;
  if (!quote?.multiChainRoot) return undefined;
  const other = (quote.quotes ?? []).map((q: any) => Number(q?.chainId)).find((id: number) => Number.isFinite(id) && id !== ownChainId);
  return other;
}

/** The receipt on `chainId`, when the relay tagged receipts with chains. */
export function receiptOnChain(receipts: readonly RelayReceipt[], chainId: number | undefined): RelayReceipt | undefined {
  if (chainId === undefined) return undefined;
  return receipts.find((r) => r.chainId !== undefined && Number(r.chainId) === chainId);
}

/**
 * What an intent needs from the wallet.
 *
 * `needs` answers it per chain and token, which is the only form that survives
 * a cross-asset quote. See `needsFromPrepared`.
 *
 * `nativeNeeded` is the one native figure callers that read a single number
 * still get: the native part of what the payer needs on the chain they pay
 * from. For a single-chain quote that is the fee (when paid natively) plus the
 * value the calls carry, or the relay's own asset deficit when it says the
 * wallet is short — exactly as before. For a multichain quote it is the
 * funding chain's own cost, and it is 0 when that chain is paid in a token,
 * because then no native balance is needed there at all.
 */
export function nativeNeededFromPrepared(
  prepared: any,
  args: {
    fee: bigint;
    value: bigint;
    feeToken: Address;
    /** The quote's per-leg charges, when already read. */
    charges?: readonly LegCharge[];
    /** The chain the intent runs on: the destination of a multichain quote. */
    ownChainId?: number;
    /** The chain the payer pays from: the funding leg of a multichain quote. */
    payChainId?: number;
    /** Whose asset diffs the escrow outflow is read from. */
    payer?: Address;
  },
): { nativeNeeded: bigint; nativeNeededFromRelay: boolean; needs: readonly QuoteNeed[] } {
  const needs = needsFromPrepared(prepared, args);
  const payChain = payKeyChain(prepared, args);
  const native = needs.find((n) => n.token.toLowerCase() === NATIVE_TOKEN && n.chainId === payChain);
  return {
    nativeNeeded: native?.amount ?? 0n,
    nativeNeededFromRelay: native?.fromRelay ?? false,
    needs,
  };
}

/**
 * The chain `needs` is keyed by for the payer: the funding chain of a
 * multichain quote, otherwise the intent's own chain, and when the relay's
 * quote named no chain at all, undefined — the same key `needsFromPrepared`
 * uses, so the two never disagree.
 */
function payKeyChain(
  prepared: any,
  args: { ownChainId?: number; payChainId?: number },
): number | undefined {
  if (args.payChainId !== undefined) return args.payChainId;
  if (args.ownChainId !== undefined) return args.ownChainId;
  return chainIdOfQuote((prepared?.context?.quote?.quotes ?? [])[0]);
}

/**
 * What the payer must hold for a quoted intent, per chain and token.
 *
 * **Single-chain quote:** the leg's fee in the leg's own token, plus the
 * native value the calls carry.
 *
 * **Multichain quote** (a registry write the relay funds from an L2): only the
 * funding chain costs the payer anything. There the wallet locks an escrow and
 * pays that leg's fee; the destination chain is paid by the relay's funder and
 * the escrow repays it, so adding the destination leg would charge the payer
 * twice. The escrow is read from the outgoing asset diffs the relay simulated
 * for the payer on the funding chain — the relay's own figure for what leaves
 * the wallet, which is the only place a cross-asset quote states the converted
 * source amount. Those diffs carry the escrow and not the leg's fee (the fee
 * goes to `paymentRecipient`, which the relay accounts separately; observed on
 * the testnet relay, `celo-harness/evidence/2026-10-15-spine-local-11-31-31-wire.json`),
 * so the two add without overlapping.
 *
 * **When the relay sent no asset diffs** for the payer on the funding chain —
 * an older relay, or a quote with diffs switched off — there is no converted
 * amount to read, so the figure falls back to what the SDK has always assumed:
 * every leg's fee plus the value, all charged on the funding chain in that
 * leg's token. That is only right when one unit of the source asset repays one
 * unit of the destination asset, which is exactly what those relays do.
 *
 * In both shapes the relay's own asset deficits act as a floor per chain and
 * token: when it says the wallet is short by more than the derived figure, its
 * figure wins.
 */
export function needsFromPrepared(
  prepared: any,
  args: {
    /** The fee on the paying chain, as `feeFromPrepared` reduced it. */
    fee: bigint;
    /** The token that fee is charged in. */
    feeToken: Address;
    /** Native value the intent's calls carry, on the intent's own chain. */
    value: bigint;
    charges?: readonly LegCharge[];
    ownChainId?: number;
    payChainId?: number;
    payer?: Address;
  },
): readonly QuoteNeed[] {
  const quotes: any[] = prepared?.context?.quote?.quotes ?? [];
  if (quotes.length === 0) return [];
  const charges = args.charges ?? chargesFromPrepared(quotes);
  const multichain =
    args.payChainId !== undefined &&
    args.ownChainId !== undefined &&
    args.payChainId !== args.ownChainId;

  const acc = new Map<string, { need: QuoteNeed }>();
  const key = (chainId: number | undefined, token: Address) => `${chainId ?? "?"}:${token.toLowerCase()}`;
  const add = (chainId: number | undefined, token: Address, amount: bigint, meta?: { symbol?: string; decimals?: number }) => {
    if (amount === 0n) return;
    const k = key(chainId, token);
    const found = acc.get(k);
    if (found) {
      found.need.amount += amount;
      if (meta?.symbol !== undefined && found.need.symbol === undefined) found.need.symbol = meta.symbol;
      if (meta?.decimals !== undefined && found.need.decimals === undefined) found.need.decimals = meta.decimals;
      return;
    }
    acc.set(k, {
      need: {
        ...(chainId !== undefined ? { chainId } : {}),
        token,
        amount,
        fromRelay: false,
        ...(meta?.symbol !== undefined ? { symbol: meta.symbol } : {}),
        ...(meta?.decimals !== undefined ? { decimals: meta.decimals } : {}),
      },
    });
  };

  // One key per chain for the payer's side, so a quote the relay did not tag
  // with a chain still adds its fee and its value together rather than
  // splitting them over two entries that no balance check would ever join.
  const payChain = payKeyChain(prepared, args);
  // `args.fee` is already the charge on the paying chain in its own token
  // (`feeFromPrepared` reduced it with the same `payChainId`), so it is used
  // rather than re-derived: one figure, one place it comes from. The relay's
  // own diffs name the token, so a fee in an ERC-20 reads as "0.622991 USDC"
  // rather than as a base-unit integer beside an address.
  add(payChain, args.feeToken, args.fee, tokenMeta(prepared, payChain, args.feeToken));
  if (!multichain) {
    add(payChain, NATIVE_TOKEN, args.value);
  } else {
    const outgoing = args.payer ? outgoingDiffs(prepared, { chainId: payChain, payer: args.payer }) : [];
    if (outgoing.length > 0) {
      for (const o of outgoing) add(payChain, o.token, o.amount, o);
    } else {
      // No diffs to read the converted escrow from: fall back to the 1:1
      // figure, every other leg's fee plus the value, in the paying token.
      const others = charges.filter((c) => c.chainId !== payChain).reduce((sum, c) => sum + c.fee, 0n);
      add(payChain, args.feeToken, others + args.value);
    }
  }

  // The relay's deficits are a floor, per chain and token, and only on the
  // chain the payer actually pays from: on a multichain quote the destination
  // deficits are what made the relay fund the intent in the first place, and
  // the escrow already covers them.
  for (const q of quotes) {
    const chainId = chainIdOfQuote(q);
    if (multichain && chainId !== args.payChainId) continue;
    for (const d of (q?.assetDeficits ?? []) as any[]) {
      const token = isNativeAddress(d?.address) ? NATIVE_TOKEN : getAddress(String(d.address));
      const required = toBigInt(d?.required);
      if (required === 0n) continue;
      const k = key(chainId, token);
      const found = acc.get(k);
      if (!found) {
        acc.set(k, { need: { ...(chainId !== undefined ? { chainId } : {}), token, amount: required, fromRelay: true } });
      } else if (required >= found.need.amount) {
        // `>=`, not `>`: when the two agree the figure is the relay's, which is
        // what `nativeNeededFromRelay` has always reported for that case.
        found.need.amount = required;
        found.need.fromRelay = true;
      }
    }
  }

  return [...acc.values()].map((v) => v.need);
}

/**
 * The symbol and decimals the relay gave a token on one chain, from anywhere
 * in the response's `assetDiffs`.
 *
 * Direction and holder are ignored on purpose: this asks what the token is,
 * not what moved. A single-chain quote's fee is charged in a token whose only
 * description in the whole payload may be an incoming diff on the recipient's
 * side, and without it the fee prints as "622991 of token 0x01C5…" (qa,
 * evidence/2026-11-05-qa-option-b-relay-staging-rerun.md). Nothing is invented:
 * a token the relay did not describe still prints as a raw amount.
 *
 * Native is left alone. Its decimals and symbol come from the chain, which is
 * where every reader already takes them from, and the relay's own spelling of
 * a testnet native token ("CELO" where the chain says "S-CELO") is not worth
 * introducing as a second source for the one token that never needed one.
 */
function tokenMeta(
  prepared: any,
  chainId: number | undefined,
  token: Address,
): { symbol?: string; decimals?: number } | undefined {
  if (chainId === undefined || token.toLowerCase() === NATIVE_TOKEN) return undefined;
  const byChain = prepared?.capabilities?.assetDiffs;
  if (typeof byChain !== "object" || byChain === null) return undefined;
  const entry = Object.entries(byChain as Record<string, unknown>).find(([k]) => chainIdOfKey(k) === chainId);
  if (!entry || !Array.isArray(entry[1])) return undefined;
  const wanted = token.toLowerCase();
  for (const tuple of entry[1] as unknown[]) {
    if (!Array.isArray(tuple) || tuple.length < 2 || !Array.isArray(tuple[1])) continue;
    for (const d of tuple[1] as any[]) {
      const address = isNativeAddress(d?.address) ? NATIVE_TOKEN : String(d?.address).toLowerCase();
      if (address !== wanted) continue;
      const symbol = typeof d?.symbol === "string" && d.symbol.length > 0 ? d.symbol : undefined;
      const decimals = typeof d?.decimals === "number" ? d.decimals : undefined;
      if (symbol !== undefined || decimals !== undefined) {
        return { ...(symbol !== undefined ? { symbol } : {}), ...(decimals !== undefined ? { decimals } : {}) };
      }
    }
  }
  return undefined;
}

/**
 * What the relay simulated leaving `payer` on `chainId`, per token, from the
 * response's `assetDiffs`. Escrowed funds show up here, and for a cross-asset
 * quote this is the only statement of the converted source amount.
 *
 * The EIP-7708 system-address duplicate is already gone: every relay response
 * passes through `stripEip7708AssetDiffs` in the transport.
 */
export function outgoingDiffs(
  prepared: any,
  args: { chainId: number | undefined; payer: Address },
): readonly { token: Address; amount: bigint; symbol?: string; decimals?: number }[] {
  if (args.chainId === undefined) return [];
  const byChain = prepared?.capabilities?.assetDiffs;
  if (typeof byChain !== "object" || byChain === null) return [];
  // Chain keys come as hex ("0xaa044c"); match by value, not by spelling.
  const entry = Object.entries(byChain as Record<string, unknown>).find(([k]) => chainIdOfKey(k) === args.chainId);
  if (!entry || !Array.isArray(entry[1])) return [];
  const payer = args.payer.toLowerCase();
  const out = new Map<string, { token: Address; amount: bigint; symbol?: string; decimals?: number }>();
  for (const tuple of entry[1] as unknown[]) {
    if (!Array.isArray(tuple) || tuple.length < 2 || !Array.isArray(tuple[1])) continue;
    if (String(tuple[0]).toLowerCase() !== payer) continue;
    for (const d of tuple[1] as any[]) {
      if (d?.direction !== "outgoing") continue;
      const token = isNativeAddress(d?.address) ? NATIVE_TOKEN : getAddress(String(d.address));
      const amount = toBigInt(d?.value);
      if (amount === 0n) continue;
      const k = token.toLowerCase();
      const found = out.get(k);
      if (found) {
        found.amount += amount;
        continue;
      }
      out.set(k, {
        token,
        amount,
        ...(typeof d?.symbol === "string" && d.symbol.length > 0 ? { symbol: d.symbol } : {}),
        ...(typeof d?.decimals === "number" ? { decimals: d.decimals } : {}),
      });
    }
  }
  return [...out.values()];
}

/** True for the ways a relay response spells "the chain's native token". */
function isNativeAddress(address: unknown): boolean {
  return address === null || address === undefined || String(address).toLowerCase() === NATIVE_TOKEN;
}

function chainIdOfQuote(q: any): number | undefined {
  return chainIdOfKey(q?.chainId);
}

function chainIdOfKey(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The relay's quoted legs, each with its own gas budget.
 *
 * Per leg, never summed. The relay adds its buffer per intent
 * (`relay src/types/simulator.rs:100`) and the Orchestrator evaluates the 63/64
 * gas check per intent against that intent's own `combinedGas`
 * (`Orchestrator.sol:331`), so a leg fits or starves on its own number. A sum
 * can look comfortable while one leg starves, and an estimate derived by
 * subtracting ONE buffer from a sum of two is wrong by a whole buffer — which
 * is what made the same `registerKey` call appear to cost 7.6x more on one
 * wallet than another (infra, 2026-10-15).
 */
export function quoteLegsFromPrepared(prepared: any): readonly QuoteLeg[] {
  const quotes: any[] = prepared?.context?.quote?.quotes ?? [];
  return quotes.map((q) => {
    const g = q?.intent?.combinedGas;
    const chainId = q?.chainId;
    return {
      ...(chainId !== undefined && chainId !== null ? { chainId: Number(chainId) } : {}),
      ...(g !== undefined && g !== null && g !== "" ? { combinedGas: toBigInt(g) } : {}),
    };
  });
}

/**
 * Reads the fee out of a prepareCalls response (porto decodes the quote's hex
 * amounts), per leg and in each leg's own token.
 *
 * `charges` is the real answer: one entry per quoted leg, with the token that
 * leg is charged in. `fee`, `feeToken` and `feeTokenDeficit` reduce it to the
 * one number most callers want: the charge on `payChainId`, the chain the payer
 * pays from. Summing the legs instead would be wrong twice over on a
 * multichain quote — it adds CELO to ETH when a cross-asset relay prices the
 * legs in different tokens, and even when both legs are "native" that is the
 * same zero address standing for two different assets. The destination leg is
 * the relay funder's to pay; the escrow the source leg locks repays it, and
 * `needs` carries that escrow.
 *
 * With no `payChainId`, or no leg on it, the legs are summed as they always
 * were. That is every quote whose legs the relay did not tag with a chain.
 */
export function feeFromPrepared(
  prepared: any,
  opts: {
    /** The chain the payer pays from: the funding leg of a multichain quote. */
    payChainId?: number;
  } = {},
): { fee: bigint; feeToken: Address | undefined; feeTokenDeficit: bigint; charges: readonly LegCharge[] } {
  const quotes: any[] = prepared?.context?.quote?.quotes ?? [];
  if (quotes.length === 0) {
    throw new Error("The relay's prepareCalls response carried no quote to read a fee from.");
  }
  const charges = chargesFromPrepared(quotes);
  const paying = opts.payChainId === undefined ? [] : charges.filter((c) => c.chainId === opts.payChainId);
  const counted = paying.length === 0 ? charges : paying;
  const countedQuotes = counted === charges ? quotes : quotes.filter((q) => chainIdOfQuote(q) === opts.payChainId);
  return {
    fee: counted.reduce((sum, c) => sum + c.fee, 0n),
    // Undefined when no counted leg names a payment token, so the caller's own
    // fee-token rule still decides, exactly as before.
    feeToken: countedQuotes.map((q) => paymentTokenOfIntent(q?.intent)).find((t) => t !== undefined),
    feeTokenDeficit: counted.reduce((sum, c) => sum + c.feeTokenDeficit, 0n),
    charges,
  };
}

/** One charge per quoted leg, in that leg's own token. */
function chargesFromPrepared(quotes: readonly any[]): readonly LegCharge[] {
  return quotes.map((q) => {
    const chainId = chainIdOfQuote(q);
    return {
      ...(chainId !== undefined ? { chainId } : {}),
      feeToken: paymentTokenOfIntent(q?.intent) ?? NATIVE_TOKEN,
      // The relay's intent comes in two shapes: the current one names the fee
      // `paymentMaxAmount`, the newer one `totalPaymentMaxAmount`.
      fee: toBigInt(q?.intent?.totalPaymentMaxAmount ?? q?.intent?.paymentMaxAmount),
      feeTokenDeficit: toBigInt(q?.feeTokenDeficit),
    };
  });
}

/** An intent's payment token, when it names a real address. */
function paymentTokenOfIntent(intent: unknown): Address | undefined {
  const token = (intent as { paymentToken?: unknown } | undefined)?.paymentToken;
  return typeof token === "string" && /^0x[0-9a-fA-F]{40}$/.test(token) ? getAddress(token) : undefined;
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
  if (!opts.skipFirstActionPrepend && needsFirstActionPrepend(opts.network, opts.submittingKey.role)) {
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
    ...(opts.requiredFunds?.length ? { requiredFunds: opts.requiredFunds } : {}),
    ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
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
    () => retryInvalidNonce(() => prepareCalls(client, prepareParams)),
    "prepare the call",
    { client, network: opts.network },
    intentContext(walletAddress, effectiveCalls, chosenFeeToken, opts),
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
  intent?: IntentContext,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // A transport failure carries no relay message at all: nothing answered.
    const reason = deepestRelayReason(err) ?? transportFailure(err);
    if (!reason) throw err;
    throw await explainRelayError({ reason, doing, err, ...(relay ? { relay } : {}), ...(intent ? { intent } : {}) });
  }
}

/** Every message an error and its causes carry, outermost first. */
function errorTexts(err: unknown, limit = 12): string[] {
  const texts: string[] = [];
  let cur: any = err;
  for (let i = 0; i < limit && cur && typeof cur === "object"; i++) {
    for (const raw of [cur.details, cur.shortMessage, cur.message]) {
      const text = typeof raw === "string" ? raw.split("\n")[0]!.trim() : "";
      if (text) texts.push(text);
    }
    cur = cur.cause;
  }
  return texts;
}

/** Wrappers that mean the request never reached a relay, or reached none that answered. */
const TRANSPORT_FAILURE =
  /HTTP request failed|fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|socket hang up|network error|ETIMEDOUT|request timed out/i;

/**
 * The transport's own words, when the failure is that nothing answered.
 *
 * `deepestRelayReason` drops these on purpose: they are the generic wrappers
 * that hide a real relay message. When they are all there is, the failure IS
 * the transport, and the error map says so rather than rethrowing viem's
 * sentence at a person.
 */
function transportFailure(err: unknown): string | undefined {
  return errorTexts(err).find((t) => TRANSPORT_FAILURE.test(t));
}

/**
 * The sentence a person is shown for a relay failure, with the long form kept
 * for the log.
 *
 * `detail` is exactly what this layer used to throw: the request it was
 * making, the relay's words, the calls simulated and the balances read. None
 * of it reaches a screen any more. What does is one sentence from
 * `explainRelayFailure`, and the facts it is built from are the SDK's own: the
 * balances it read, the quote the caller took, the tokens the relay accepts.
 */
async function explainRelayError(args: {
  reason: string;
  doing: string;
  err: unknown;
  relay?: { client: ReturnType<typeof buildRelayClient>; network: NetworkConfig };
  intent?: IntentContext;
}): Promise<Error> {
  const { reason, doing, err, relay, intent } = args;
  const detail = await composeFailureDetail(reason, doing, relay, intent);
  // What the relay said, read for meaning once. A cause it named (an expired
  // key, a spend cap, a chain it does not serve) is the cause, and the
  // balances are not read at all; only a funding or unexplained failure
  // justifies the second round trip.
  const provisional = classifyRelayFailure({ relayMessage: reason });
  /**
   * The relay was asked to front funds from another chain and reverted with
   * no reason, which is what it answers when it could not source them: the
   * shortfall is in its own log to the wei, and `0x` is all that reaches the
   * caller (qa, 2026-11-09, 6e). The SDK is the only layer that can turn that
   * back into a sentence, because it knows what it asked for.
   */
  const refusedToFund = Boolean(intent?.funded) && EMPTY_REVERT.test(reason);
  const balance: PayerBalance =
    (provisional === "insufficient_funds" || provisional === "unknown") && relay && intent
      ? await payerBalance(relay, intent, refusedToFund)
      : { kind: "unknown" };
  const shortfall = balance.kind === "short" ? balance.shortfall : undefined;
  // Withheld when the payer's balance covers the quote the caller took: that
  // is evidence the cause is something else, and telling a wallet that can pay
  // to add funds is the error this rule has made before.
  const fundingRefused = refusedToFund && balance.kind !== "covers";
  const feeSymbol =
    provisional === "price_unavailable" || provisional === "spend_limit_exceeded"
      ? await feeTokenSymbol(relay, intent?.feeToken)
      : undefined;
  const facts: RelayFailureFacts = {
    relayMessage: reason,
    detail,
    cause: err,
    ...(shortfall ? { shortfall } : {}),
    ...(fundingRefused ? { fundingRefused } : {}),
    ...(feeSymbol ? { feeSymbol } : {}),
    ...(intent?.operation ? { operation: intent.operation } : {}),
    ...(relay
      ? {
          chain: { name: relay.network.chain.name, chainId: relay.network.chainId },
          ...(relay.network.relayUrl ? { relayUrl: relay.network.relayUrl } : {}),
        }
      : {}),
  };
  return explainRelayFailure(facts);
}

/** The long form: what was asked, what the relay said, and what the SDK checked. */
async function composeFailureDetail(
  reason: string,
  doing: string,
  relay?: { client: ReturnType<typeof buildRelayClient>; network: NetworkConfig },
  intent?: IntentContext,
): Promise<string> {
  const lead = `The relay rejected the request to ${doing}`;
  if (EMPTY_REVERT.test(reason) && relay && intent) {
    const what = await describeEmptyRevert(relay.client, relay.network, intent);
    return `${lead}: ${what} (relay: ${reason})`;
  }
  const hint =
    /fee token/i.test(reason) && relay ? await feeTokenHint(relay.client, relay.network) : relayRejectionHint(reason);
  return `${lead}: ${reason}${hint}`;
}

/** The symbol of the token a fee was to be charged in, when it can be named. */
async function feeTokenSymbol(
  relay: { client: ReturnType<typeof buildRelayClient>; network: NetworkConfig } | undefined,
  feeToken: Address | undefined,
): Promise<string | undefined> {
  if (!relay || !feeToken) return undefined;
  if (isNativeAddress(feeToken)) return relay.network.chain.nativeCurrency.symbol;
  const tokens = await acceptedFeeTokens(relay.client, relay.network);
  return tokens.find((t) => t.address.toLowerCase() === feeToken.toLowerCase())?.symbol;
}

/**
 * The chain a funded intent is paid from, when the caller did not name one.
 *
 * A registry write runs on the registry chain and is paid from the balance on
 * the chain whose registry it is, which the config states: Celo Sepolia keeps
 * its KeyStore in Sepolia's, so a Sepolia intent for a Celo wallet is paid in
 * CELO. Where several configured chains share a registry, the one the wallet
 * actually holds something on is the one the relay would have drawn from.
 */
function fundingNetwork(intentNetwork: NetworkConfig, holdings: readonly Holding[]): NetworkConfig | undefined {
  const candidates = [...new Set(holdings.map((h) => h.chainId))]
    .filter((chainId) => chainId !== intentNetwork.chainId)
    .map((chainId) => networkByChainId(chainId))
    .filter((n): n is NetworkConfig => !!n && registryNetwork(n).chainId === intentNetwork.chainId);
  if (candidates.length <= 1) return candidates[0];
  const value = (n: NetworkConfig) =>
    holdings
      .filter((h) => h.chainId === n.chainId)
      .reduce((most, h) => (h.balance > most ? h.balance : most), 0n);
  return [...candidates].sort((a, b) => (value(b) > value(a) ? 1 : value(b) < value(a) ? -1 : 0))[0];
}

/**
 * What the SDK could establish about the payer's balance, which is three
 * answers and not two.
 *
 * `covers` is the one worth having a name for: a balance that covers the quote
 * the caller took is positive evidence that the failure is not about money,
 * and it is what stops an unexplained revert being dressed up as a shortfall.
 * `unknown` is the absence of evidence either way, which is not the same thing.
 */
type PayerBalance =
  | { kind: "short"; shortfall: FundingShortfall }
  | { kind: "covers" }
  | { kind: "unknown" };

/**
 * What the payer is short of, in the token the payer pays with, on the chain
 * the payer holds it on.
 *
 * Two rules decide what this may say.
 *
 * It may only name the chain the payer pays from. A registry write on Ethereum
 * funded from a Celo balance is short of CELO on Celo, and a message about the
 * wallet's ETH on Ethereum describes the product's whole purpose as a fault.
 * For a funded intent the paying chain is the one the caller named
 * (`fundFrom`); without one, nothing is returned, because the only other
 * candidate is the destination.
 *
 * It may only state a figure the SDK has. The need comes from a quote the
 * caller already took, or from the native value the calls carry when the
 * intent is not funded from elsewhere. The relay will not quote for a request
 * it has refused, so the honest answer is often `have` alone. qa lost an hour
 * to the inverse, a wallet holding 133x the fee told it could not pay
 * (`evidence/2026-09-28-s3-registry-write-reverts-0x.md`), which is why
 * `covers` is a state of its own: a balance that covers the quote the caller
 * took is evidence against a funding failure, and is reported as such rather
 * than folded into "nothing to say".
 */
async function payerBalance(
  relay: { client: ReturnType<typeof buildRelayClient>; network: NetworkConfig },
  intent: IntentContext,
  /** Whether the relay refused to source the funds, which is a shortfall with no figure. */
  refusedToFund = false,
): Promise<PayerBalance> {
  const holdings = await readHoldings(relay.client, intent.account).catch(() => undefined);
  if (!holdings) return { kind: "unknown" };

  /**
   * The judgement the debug log already makes, in `balanceClause`: a wallet
   * holding more on the intent's own chain than the calls send is a wallet
   * whose balance is not the cause. It is read first, so the sentence and the
   * log cannot disagree about whether money was the problem, and so a revert
   * the relay did not explain is not turned into a shortfall for a wallet
   * that could pay (`evidence/2026-09-28-s3-registry-write-reverts-0x.md`).
   */
  const onIntentChain = holdings.find(
    (h) => h.chainId === relay.network.chainId && h.token.toLowerCase() === NATIVE_TOKEN.toLowerCase(),
  );
  if ((onIntentChain?.balance ?? 0n) > totalValue(intent.calls)) return { kind: "covers" };

  const payNetwork = intent.funded ? (intent.fundFrom ?? fundingNetwork(relay.network, holdings)) : relay.network;
  if (!payNetwork) return { kind: "unknown" };

  // The token the payer pays with: the one the caller named when it is charged
  // on this chain, the paying chain's own currency otherwise.
  const namedHere =
    intent.feeToken !== undefined &&
    !isNativeAddress(intent.feeToken) &&
    payNetwork.chainId === relay.network.chainId
      ? getAddress(intent.feeToken)
      : undefined;
  const token = namedHere ?? NATIVE_TOKEN;
  const held = holdings.find(
    (h) => h.chainId === payNetwork.chainId && h.token.toLowerCase() === token.toLowerCase(),
  );
  const have = held?.balance ?? 0n;
  const symbol = held?.symbol ?? (namedHere ? undefined : payNetwork.chain.nativeCurrency.symbol);
  const decimals = held?.decimals ?? (namedHere ? undefined : payNetwork.chain.nativeCurrency.decimals);
  // A token the relay did not describe cannot be named in a sentence.
  if (symbol === undefined || decimals === undefined) return { kind: "unknown" };

  const quoted =
    intent.expectedCost &&
    intent.expectedCost.chainId === payNetwork.chainId &&
    intent.expectedCost.token.toLowerCase() === token.toLowerCase() &&
    intent.expectedCost.amount > 0n
      ? intent.expectedCost.amount
      : undefined;
  const sends = !intent.funded && token === NATIVE_TOKEN ? totalValue(intent.calls) : 0n;
  const need = quoted ?? (sends > 0n ? sends : undefined);
  if (need !== undefined) {
    if (have >= need) return { kind: "covers" };
  } else if (have > 0n && !refusedToFund) {
    // No figure to compare against, and nothing that says the funding failed.
    // A nonzero balance on its own does not establish a shortfall: that is
    // the 2026-09-28 mistake.
    return { kind: "unknown" };
  }

  const payClient = payNetwork.chainId === relay.network.chainId ? relay.client : buildRelayClient(payNetwork);
  const tokens = await acceptedFeeSymbols(payClient, payNetwork);
  return {
    kind: "short",
    shortfall: {
      token: { symbol, decimals },
      ...(need !== undefined ? { need } : {}),
      have,
      fund: { chain: payNetwork.chain.name, ...(tokens.length > 0 ? { tokens } : { tokens: [symbol] }) },
    },
  };
}

/** The relay's simulation reverted with no reason bytes ("intent reverted: 0x" or a bare "0x"). */
const EMPTY_REVERT = /(^|\s)0x$/;

/** The account rejected the nonce the relay chose. */
const INVALID_NONCE = /InvalidNonce/i;

/**
 * How long to wait before asking again, in order. One retry is enough in
 * practice; the rest are for a slow block.
 */
export const NONCE_RETRY_DELAYS_MS = [2_000, 4_000, 6_000];

/**
 * Retries a prepare the account rejected for its nonce.
 *
 * The relay chooses an intent's nonce by reading the account's nonce on chain
 * at `latest` and remembers nothing between requests, so a wallet's second
 * operation is prepared against a chain state that does not yet include its
 * first one, and the account rejects the nonce it is given. Measured on the
 * live relay: the failure is not about how close together the calls arrive,
 * because nothing is ever reserved
 * (`celo-harness/evidence/2026-09-28-back-to-back-race-attribution.md`).
 *
 * Asking again is the whole fix. The relay re-reads the chain on every prepare,
 * so the next attempt gets the nonce that has since become correct, and nothing
 * has been signed or sent in between. Live on Celo Sepolia, four back-to-back
 * operations on one wallet each succeeded on the attempt after the rejection.
 *
 * The SDK does not supply `capabilities.meta.nonce` to extend **the relay's**
 * lane, and that part of this note still holds: the relay's own choice of
 * sequence key is not something a client can predict. A counterfactual wallet's
 * first intent gets a random sequence key, and every intent after the
 * delegation lands uses key 0, so counting up from the previous intent's nonce
 * on that lane is wrong exactly when it matters, and measurably so.
 *
 * Since 2026-10-17 an app transaction does carry a nonce, on a lane nothing
 * else writes to (`appNonceLane.ts`), which is a different claim: on its own
 * lane the next counter IS predictable, and the undelegated case this note
 * names is handled by sending no nonce at all until the account can be asked.
 * This retry still guards everything on lane 0, where the relay allocates.
 *
 * The relay-side fix is still the one that would help every client at once:
 * allocate from `max(on-chain, in-flight) + 1` the way its precall path already
 * does (`QUESTIONS/sdk.md`, 2026-10-17).
 */
export async function retryInvalidNonce<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = NONCE_RETRY_DELAYS_MS,
): Promise<T> {
  for (const delay of delaysMs) {
    try {
      return await fn();
    } catch (err) {
      const reason = deepestRelayReason(err);
      if (reason === undefined || !INVALID_NONCE.test(reason)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // The last attempt's error is the caller's, un-swallowed.
  return await fn();
}

/** What the SDK asked the relay to simulate, for explaining an empty revert. */
export type IntentContext = {
  account: Address;
  /** The calls the relay simulated, in order. */
  calls: readonly Call[];
  /** Whether the request asked the relay to fund the intent from another chain. */
  funded: boolean;
  /** The token the fee was to be charged in, when the caller named one. */
  feeToken?: Address;
  /** What the person is doing, in their words. See `SubmitCallsOptions.operation`. */
  operation?: string;
  /** The chain the payer pays from, when it is not the intent's own. */
  fundFrom?: NetworkConfig;
  /** What a quote taken before this said it costs the payer. */
  expectedCost?: { chainId: number; token: Address; amount: bigint };
};

/** The facts about one intent a failure may be worded from. */
function intentContext(
  account: Address,
  calls: readonly Call[],
  feeToken: Address | undefined,
  opts: SubmitCallsOptions,
): IntentContext {
  return {
    account,
    calls,
    funded: Boolean(opts.requiredFunds?.length),
    ...(feeToken ? { feeToken } : {}),
    ...(opts.operation ? { operation: opts.operation } : {}),
    ...(opts.fundFrom ? { fundFrom: opts.fundFrom } : {}),
    ...(opts.expectedCost ? { expectedCost: opts.expectedCost } : {}),
  };
}

/** A wallet's native balance on one chain, as the relay reports it. */
export type NativeHolding = { chainId: number; chain: string; symbol: string; decimals: number; balance: bigint };

/** The chain an intent was simulated on, and its native currency, for wording a revert. */
export type IntentChain = { chain: string; chainId: number; symbol: string; decimals: number };

const SHORTFALL_READ_TIMEOUT_MS = 3_000;

/** Native wei a set of calls sends. */
function totalValue(calls: readonly Call[]): bigint {
  return calls.reduce((sum, c) => sum + (c.value ?? 0n), 0n);
}

/** The chain's own currency, for chains the relay reports nothing about. */
function intentChainOf(network: NetworkConfig): IntentChain {
  return {
    chain: network.chain.name,
    chainId: network.chainId,
    symbol: network.chain.nativeCurrency.symbol,
    decimals: network.chain.nativeCurrency.decimals,
  };
}

/**
 * Words an empty revert: what reverted and where, plus the wallet's native
 * balances when the relay answers in time. A relay that does not answer costs
 * the balance clause and nothing else.
 */
async function describeEmptyRevert(
  relay: ReturnType<typeof buildRelayClient>,
  network: NetworkConfig,
  intent: IntentContext,
): Promise<string> {
  const where = intentChainOf(network);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("balance read timed out")), SHORTFALL_READ_TIMEOUT_MS);
    });
    const holdings = await Promise.race([readNativeHoldings(relay, intent.account), timeout]);
    const here = holdings.find((h) => h.chainId === network.chainId) ?? { ...where, balance: 0n };
    const elsewhere = intent.funded ? holdings.filter((h) => h.chainId !== network.chainId) : [];
    return emptyRevertMessage(where, intent.calls, { here, elsewhere });
  } catch {
    return emptyRevertMessage(where, intent.calls);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sentence for a relay simulation that reverted with no reason bytes.
 *
 * The revert says nothing, so neither does this: it names the chain and the
 * calls, and adds the balance only as what it is. A balance below the value
 * the calls send is a shortfall and reads as one; a balance above it is not,
 * and the sentence says so instead of inventing a shortfall the numbers
 * contradict.
 */
export function emptyRevertMessage(
  where: IntentChain,
  calls: readonly Call[],
  balances?: { here: NativeHolding; elsewhere: readonly NativeHolding[] },
): string {
  const lead = `its simulation reverted with no reason on ${where.chain} (chainId ${where.chainId})${describeCalls(where, calls)}`;
  return balances === undefined ? lead : `${lead}; ${balanceClause(balances.here, totalValue(calls), balances.elsewhere)}`;
}

/** How many calls the relay simulated, where they went, and what they send. */
function describeCalls(where: IntentChain, calls: readonly Call[]): string {
  if (calls.length === 0) return "";
  const targets = [...new Set(calls.map((c) => getAddress(c.to)))];
  const listed = targets.slice(0, 3).join(", ");
  const more = targets.length > 3 ? ` and ${targets.length - 3} more` : "";
  const value = totalValue(calls);
  const sends = value > 0n ? `, sending ${formatUnits(value, where.decimals)} ${where.symbol}` : "";
  return `, simulating ${calls.length === 1 ? "1 call" : `${calls.length} calls`} to ${listed}${more}${sends}`;
}

/** Whether the wallet's native balance explains the revert, worded either way. */
export function balanceClause(here: NativeHolding, value: bigint, elsewhere: readonly NativeHolding[]): string {
  const amount = (h: NativeHolding, wei: bigint) => `${formatUnits(wei, h.decimals)} ${h.symbol}`;
  if (here.balance > value) {
    return (
      `the wallet's balance is not the cause: it holds ${amount(here, here.balance)} on ${here.chain}, ` +
      `more than the ${amount(here, value)} the calls send`
    );
  }
  const needs = value > 0n ? `${amount(here, value)} the calls send plus the relay fee` : "the relay fee";
  const lead = `the wallet cannot pay for it: it holds ${amount(here, here.balance)} on ${here.chain} and needs ${needs}`;
  const faucet = faucetHint(here.chainId);
  const fund = faucet ? `; fund it at ${faucet}` : "";
  if (elsewhere.length === 0) return `${lead}${fund}`;
  const held = elsewhere.filter((h) => h.balance > 0n);
  if (held.length === 0) return `${lead}; it holds nothing on any other chain the relay could fund it from${fund}`;
  const list = held.map((h) => `${amount(h, h.balance)} on ${h.chain}`).join(" and ");
  return `${lead}; it holds ${list}, which the relay could not use to fund it`;
}

/** One balance the relay reported: a token on a chain. */
export type Holding = {
  chainId: number;
  chain: string;
  /** The token's address, or the zero address for the chain's own currency. */
  token: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
};

/**
 * Every balance the relay knows for an account, on every chain the SDK is
 * configured with, from `wallet_getAssets`.
 *
 * Tokens are asked for as well as the native currency: a wallet that pays its
 * fees in a stablecoin is short of the stablecoin, and a reader that saw only
 * native balances would report it as holding nothing.
 */
async function readHoldings(relay: ReturnType<typeof buildRelayClient>, account: Address): Promise<Holding[]> {
  const response = (await withinShortfallTimeout(
    relay.request({
      method: "wallet_getAssets" as never,
      params: [{ account, assetTypeFilter: ["native", "erc20"] }] as never,
    }) as Promise<Record<string, unknown> | null>,
  )) as Record<string, unknown> | null;
  const holdings: Holding[] = [];
  for (const [key, assets] of Object.entries(response ?? {})) {
    const chainId = key.startsWith("0x") ? parseInt(key, 16) : Number(key);
    const network = networkByChainId(chainId);
    if (!network || !Array.isArray(assets)) continue;
    for (const asset of assets as any[]) {
      if (!asset) continue;
      const isNative = asset.type === "native" || asset.address === "native" || isNativeAddress(asset.address);
      const token = isNative
        ? (NATIVE_TOKEN as Address)
        : typeof asset.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(asset.address)
          ? getAddress(asset.address)
          : undefined;
      if (token === undefined) continue;
      holdings.push({
        chainId,
        chain: network.chain.name,
        token,
        // The chain config is the authority on its own currency's symbol: the
        // relay labels the native entry from whatever its asset lookup returned.
        symbol: isNative
          ? network.chain.nativeCurrency.symbol
          : typeof asset.metadata?.symbol === "string"
            ? asset.metadata.symbol
            : "",
        decimals: isNative
          ? network.chain.nativeCurrency.decimals
          : typeof asset.metadata?.decimals === "number"
            ? asset.metadata.decimals
            : 18,
        balance:
          typeof asset.balance === "string" && /^0x[0-9a-fA-F]+$/.test(asset.balance) ? hexToBigInt(asset.balance) : 0n,
      });
    }
  }
  // A token the relay named nothing for cannot be put in a sentence.
  return holdings.filter((h) => h.symbol.length > 0);
}

/** Gives up on a balance read, so a slow relay costs a clause and not the error. */
async function withinShortfallTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("balance read timed out")), SHORTFALL_READ_TIMEOUT_MS);
  });
  return await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The wallet's native balance on every chain the SDK knows, for the long form. */
async function readNativeHoldings(
  relay: ReturnType<typeof buildRelayClient>,
  account: Address,
): Promise<NativeHolding[]> {
  const holdings = await readHoldings(relay, account);
  return holdings
    .filter((h) => h.token.toLowerCase() === NATIVE_TOKEN)
    .map((h) => ({ chainId: h.chainId, chain: h.chain, symbol: h.symbol, decimals: h.decimals, balance: h.balance }));
}

/** Raw selectors, for the fee path: the Orchestrator re-reverts only 32 bytes of return data. */
const NO_SPEND_PERMISSIONS_SELECTOR = "0x5ee7e5b1";
const EXCEEDED_SPEND_LIMIT_SELECTOR = "0x9054c912";

/** Plain advice appended to relay rejections the SDK knows the cause of. */
export function relayRejectionHint(reason: string): string {
  if (/unknown account/i.test(reason)) {
    return (
      " The relay only serves accounts it has registered: create the wallet with " +
      "`client.createWallet({ signer })` (or `createPasskeyWallet`) before sending from this key."
    );
  }
  if (/NoSpendPermissions/i.test(reason) || reason.toLowerCase().includes(NO_SPEND_PERMISSIONS_SELECTOR)) {
    return (
      " NoSpendPermissions: the session has no spend limit for a token this transaction spends. Relay fees are paid" +
      " in native currency, so every session needs a native spend limit with fee headroom, even one that only sends" +
      " tokens; sending an ERC-20 needs a limit for that token too. Grant a new session, permissions cannot be widened."
    );
  }
  if (/ExceededSpendLimit/i.test(reason) || reason.toLowerCase().includes(EXCEEDED_SPEND_LIMIT_SELECTOR)) {
    const token = /token:\s*(0x[0-9a-fA-F]{40})/.exec(reason)?.[1];
    if (token && token.toLowerCase() !== NATIVE_TOKEN) {
      return (
        ` ExceededSpendLimit: the session's spend cap for ${token} is exhausted for this period. Check the cap` +
        ` against the token's decimals.`
      );
    }
    return " ExceededSpendLimit: the session's native spend cap is exhausted for this period; that cap also pays relay fees.";
  }
  if (EMPTY_REVERT.test(reason)) {
    return (
      " The relay's simulation reverted with no reason, so the response says nothing about the cause: the usual ones" +
      " are a balance below the value the calls send plus the relay fee, and a call that reverts without a message."
    );
  }
  return "";
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
  return best === undefined ? undefined : decodeRevertText(best);
}

/** Replaces `Error(string)` and `Panic(uint256)` revert data at the end of a reason with its meaning. */
export function decodeRevertText(reason: string): string {
  return reason.replace(/0x(08c379a0|4e487b71)[0-9a-fA-F]+$/, (data) => {
    try {
      const { errorName, args } = decodeErrorResult({ abi: SOLIDITY_REVERTS, data: data as Hex });
      return errorName === "Error" ? `"${String(args?.[0])}"` : `panic code ${String(args?.[0])}`;
    } catch {
      return data;
    }
  });
}

const SOLIDITY_REVERTS = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as const;

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
  /** Chain the receipt is from; set by the relay on multichain bundles. */
  chainId?: Hex | number;
  transactionHash?: Hex;
  status?: Hex | number;
  /** Block the transaction was mined in. porto decodes it to a number; hex is accepted too. */
  blockNumber?: Hex | number | bigint;
  logs?: readonly RelayLog[];
};

/** A receipt's block number as a bigint, or undefined when the relay did not include one. */
export function receiptBlockNumber(receipt: RelayReceipt | undefined): bigint | undefined {
  const raw = receipt?.blockNumber;
  if (raw === undefined || raw === null) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

/**
 * The block a confirmed relay write landed in. The relay's own receipt is used first. Only when
 * it did not carry a block number is a public RPC asked for the receipt, retried a few times
 * because a public node can take a while to index a transaction the relay already saw mined.
 * Never throws: an unknown block comes back with the reason, so callers can refuse to build a
 * proof against it.
 */
export async function blockNumberOfWrite(args: {
  relayBlockNumber: bigint | undefined;
  transactionHash: Hex | undefined;
  publicClient: Pick<PublicClient, "getTransactionReceipt">;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ blockNumber: bigint } | { blockNumber?: undefined; blockNumberError: string }> {
  if (args.relayBlockNumber !== undefined) return { blockNumber: args.relayBlockNumber };
  if (!args.transactionHash) {
    return { blockNumberError: "the relay reported no transaction hash and no block number" };
  }
  const attempts = Math.max(1, args.attempts ?? 5);
  const retryDelayMs = args.retryDelayMs ?? 3_000;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const receipt = await args.publicClient.getTransactionReceipt({ hash: args.transactionHash });
      return { blockNumber: receipt.blockNumber };
    } catch (err) {
      lastError = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  return {
    blockNumberError:
      `the relay receipt had no block number and the public RPC receipt lookup for ` +
      `${args.transactionHash} failed ${attempts} times (${lastError})`,
  };
}

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
  opts: { chainId?: number } = {},
): Promise<{
  status: string;
  statusCode?: number;
  transactionHash?: Hex;
  /** Block of the receipt on the intent's chain, as the relay reported it. */
  blockNumber?: bigint;
  receipts?: readonly RelayReceipt[];
  /** Receipts on other chains: the source legs of a multichain bundle. */
  sourceReceipts?: readonly RelayReceipt[];
}> {
  const deadline = Date.now() + timeoutMs;
  let lastCode: number | undefined;
  const wantChain = opts.chainId ?? client.chain?.id;
  while (Date.now() < deadline) {
    try {
      const status: any = await getCallsStatus(client as any, { id: callsId });
      const code = status?.status;
      if (typeof code === "number") lastCode = code;
      if ((typeof code === "number" && code >= 200 && code < 300) || code === "CONFIRMED") {
        const receipts = (status?.receipts ?? []) as readonly RelayReceipt[];
        const own = receiptOnChain(receipts, wantChain) ?? receipts[0];
        const sourceReceipts = receipts.filter((r) => r !== own && r.chainId !== undefined && Number(r.chainId) !== wantChain);
        const blockNumber = receiptBlockNumber(own);
        return {
          status: "CONFIRMED",
          ...(typeof code === "number" ? { statusCode: code } : {}),
          transactionHash: own?.transactionHash,
          ...(blockNumber !== undefined ? { blockNumber } : {}),
          ...(status?.receipts ? { receipts } : {}),
          ...(sourceReceipts.length ? { sourceReceipts } : {}),
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
