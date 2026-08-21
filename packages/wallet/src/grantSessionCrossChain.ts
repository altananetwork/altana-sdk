import { type Address } from "viem";
import type { NetworkConfig, L2CacheConfig } from "./config.js";
import { keyStoreOf } from "./config.js";
import type { Signer } from "./internal/signer.js";
import type {
  GrantSessionOptions,
  GrantSessionResult,
  SessionPermissions,
} from "./internal/sessions.js";
import type { Wallet } from "./internal/types.js";
import type { EnsureKeyCachedStatus } from "./syncKeyToL2.js";
import { buildPublicClient } from "./internal/relay.js";
import { grantSession } from "./grantSession.js";
import { wireSessionToGateOnL2 } from "./linkSessionToGate.js";
import { ensureKeyCached } from "./syncKeyToL2.js";
import { walletClientFromSigner } from "./internal/gasPayer.js";

export type GrantSessionCrossChainConfig = {
  /** The gated L2 the session will execute on (has keyStoreCacheGate + l1ChainId). */
  l2Network: L2CacheConfig & { keyStoreCacheGate: Address; l1ChainId: number };
  /** The L1 registry chain (resolved from l2Network.l1ChainId by the client). */
  l1Network: NetworkConfig;
  /** Funded raw-key signer that pays L2 gas for the proof bridge. */
  l2GasSigner?: Signer;
  /** Also bridge the L1 proof into the L2 cache (default true). */
  bridge?: boolean;
  feeToken?: Address;
  onStatus?: (status: EnsureKeyCachedStatus) => void;
};

/**
 * Grant a session on a gated L2, hiding the three-part flow: register on the L1
 * KeyStore, wire the KeyStoreCacheGate on the L2, and bridge the L1 proof into
 * the L2 cache. The caller expresses intent exactly as on a full-stack chain
 * (permissions.calls[].to = "the session may call X"); here those targets are
 * routed through the gate rather than becoming setCanExecute allowlist entries.
 */
export async function grantSessionCrossChain(
  wallet: Wallet,
  adminSigner: Signer,
  opts: GrantSessionOptions,
  config: GrantSessionCrossChainConfig,
): Promise<GrantSessionResult> {
  const { l2Network, l1Network } = config;
  const bridge = config.bridge !== false;

  // The cache proves an L1 KeyStore entry, so the key must be registered there.
  if (opts.register === false) {
    throw new Error(
      "grantSession on a gated L2 requires register: true — the L2 gate " +
        "validates against an L1 KeyStore entry, which register: false skips.",
    );
  }

  // Split intent: the session's call targets go through the gate, so the
  // ON-ACCOUNT authorization (L1 and L2) must be spend-only.
  const calls = opts.permissions.calls ?? [];
  const targets: Address[] = [];
  for (const c of calls) {
    const to = (c as { to?: Address }).to;
    if (!to) {
      throw new Error(
        "A gated session's call rules must each name a `to` (the gate is " +
          "registered per (keyHash, target)). A signature-only rule has no " +
          "gate target.",
      );
    }
    if (!targets.some((t) => t.toLowerCase() === to.toLowerCase())) {
      targets.push(to);
    }
  }
  if (targets.length === 0) {
    throw new Error(
      "A gated session needs at least one call target (permissions.calls[].to) " +
        "— it is what the session is allowed to reach through the gate.",
    );
  }

  const spendOnly: SessionPermissions = {
    ...(opts.permissions.spend ? { spend: opts.permissions.spend } : {}),
  };

  // 1. Grant on the L1 registry (spend-only permissions).
  const session = await grantSession(
    wallet,
    adminSigner,
    { ...opts, permissions: spendOnly, register: true },
    {
      network: l1Network,
      ...(config.feeToken ? { feeToken: config.feeToken } : {}),
    },
  );

  // 2. Wire the gate on the L2 (authorize + spend + setCallChecker per target + link).
  const wired = await wireSessionToGateOnL2(wallet, adminSigner, session, {
    network: l2Network,
    gate: l2Network.keyStoreCacheGate,
    targets,
    ...(config.feeToken ? { feeToken: config.feeToken } : {}),
  });

  // 3. Bridge the L1 proof into the L2 cache so the gate can validate.
  let cached = false;
  if (bridge) {
    if (!config.l2GasSigner) {
      throw new Error(
        `Bridging the proof to chain ${l2Network.chainId} needs a funded gas ` +
          `payer. Configure relayers[${l2Network.chainId}] on createClient, pass ` +
          `l2GasSigner, or grant with bridge: false and bridge later.`,
      );
    }
    await ensureKeyCached({
      l1Client: buildPublicClient(l1Network),
      l2Client: buildPublicClient(l2Network),
      l2WalletClient: walletClientFromSigner(config.l2GasSigner, l2Network),
      l1KeyStore: keyStoreOf(l1Network),
      l2Cache: l2Network.keyStoreCache,
      user: wallet.address,
      publicKey: session.publicKey,
      ...(config.onStatus ? { onStatus: config.onStatus } : {}),
    });
    cached = true;
  }

  return {
    ...session,
    l2: {
      chainId: l2Network.chainId,
      keyHash: wired.keyHash,
      keyId: wired.keyId,
      ...(wired.transactionHash ? { wireTxHash: wired.transactionHash } : {}),
      cached,
    },
  };
}
