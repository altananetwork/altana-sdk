/**
 * Quotes a registry write's intents and prints the gas the relay budgets them.
 *
 * READ-ONLY. It calls `wallet_prepareCalls` and stops: no intent is sent, no
 * escrow is locked (escrow is created by the source transaction at send time),
 * no funds move. Safe to run against any relay as often as needed.
 *
 * Why it exists: `combinedGas` is what decides whether an intent fits, and an
 * intent that needs more runs out of gas and reverts with no reason, which the
 * Orchestrator reports as `CallError()` — naming neither gas nor the call. On
 * 2026-10-07 that cost three escrowed runs and five revisions of the relay's
 * intent buffer to establish a number a free quote already contained.
 *
 *   SDK_RELAY_URL=<relay>  SDK_WALLET_KEY=<key of a root-registered wallet> \
 *     bun tests/e2e/quote-registry-intents.ts
 *
 * The wallet should already hold a root key, so the quote is of the SESSION
 * intent alone. On a wallet with no root key the SDK prepends the root
 * registration and the quote covers that instead, which the output states.
 */
import { createPrivateKeySigner, signerFromPrivateKey } from "../../packages/wallet/src/internal/signer.js";
import { buildAdditionalRegisterCall, buildFirstActionPrepend, readRegistrationFee } from "../../packages/wallet/src/internal/keystore.js";
import { planRegistryFunding } from "../../packages/wallet/src/internal/cachedRegistry.js";
import { buildPublicClient, buildRelayClient, quoteCalls } from "../../packages/wallet/src/internal/relay.js";
import { NATIVE_TOKEN, SEPOLIA } from "../../packages/wallet/src/config.js";
import { sdkBuild } from "../../packages/wallet/src/buildInfo.js";
import type { Hex } from "viem";
import { formatEther } from "viem";

const relayUrl = process.env.SDK_RELAY_URL;
const key = process.env.SDK_WALLET_KEY as Hex | undefined;
if (!relayUrl || !key) {
  console.error("set SDK_RELAY_URL and SDK_WALLET_KEY");
  process.exit(2);
}

const registry = {
  ...SEPOLIA,
  relayUrl,
  ...(process.env.SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.SEPOLIA_RPC_URL } : {}),
};

const admin = signerFromPrivateKey(key);
const session = createPrivateKeySigner();
const registryClient = buildPublicClient(registry);

console.log(`sdk build       ${sdkBuild.describe}`);
console.log(`relay           ${relayUrl}`);
console.log(`registry chain  ${registry.chainId} (${registry.chain.name})`);
console.log(`wallet          ${admin.address}`);

// Which intent is this a quote of? The SDK prepends the root registration only
// when the wallet holds no key, so reading that decides what the number means.
const prepend = await buildFirstActionPrepend({
  publicClient: registryClient,
  network: registry,
  walletAddress: admin.address,
  adminPublicKey: admin.publicKey,
});
console.log(`root registered ${prepend.length === 0 ? "yes — this quotes the SESSION intent alone" : "NO — the SDK would prepend the root"}`);

const fee = await readRegistrationFee(registryClient, registry);
const calls = [
  buildAdditionalRegisterCall({
    publicKey: session.publicKey,
    fee,
    network: registry,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  }),
];

const requiredFunds = await planRegistryFunding({
  registryClient,
  registry,
  walletAddress: admin.address,
  adminPublicKey: admin.publicKey,
  calls,
  skipFirstActionPrepend: prepend.length > 0,
});

const quote = await quoteCalls(buildRelayClient(registry), admin.address, admin, calls, {
  feeToken: NATIVE_TOKEN,
  requiredFunds,
  submittingKey: { type: "secp256k1", publicKey: admin.publicKey, role: "admin" },
  network: registry,
  skipFirstActionPrepend: true,
});

console.log("");
console.log(`combinedGas     ${quote.combinedGas ?? "(the relay's quote did not carry it)"}`);
console.log(`fee             ${formatEther(quote.fee)} (${quote.fee} wei)`);
console.log(`value           ${formatEther(quote.value)}`);
console.log(`nativeNeeded    ${formatEther(quote.nativeNeeded)}${quote.nativeNeededFromRelay ? " (the relay's own figure)" : ""}`);
if (quote.fundedFromChainId !== undefined) console.log(`funded from     chain ${quote.fundedFromChainId}`);
