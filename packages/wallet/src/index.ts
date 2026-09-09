export { createClient } from "./client.js";
export type {
  Client,
  CreateClientOptions,
  ClientCreateWalletOptions,
  ClientCreatePasskeyWalletOptions,
  ClientRecoverFromPasskeyOptions,
  ClientExecuteOptions,
  ClientGrantSessionOptions,
  ClientRevokeSessionOptions,
  ClientRegisterSessionKeyOptions,
  ClientSyncSessionToCacheOptions,
  ClientBalancesOptions,
  ClientHoldingsOptions,
} from "./client.js";

export type { CreateWalletOptions, CreateWalletResult } from "./createWallet.js";
export type { CreatePasskeyWalletOptions } from "./createPasskeyWallet.js";
export type { RecoverFromPasskeyOptions } from "./recoverFromPasskey.js";
export type { ExecuteOptions, Call } from "./execute.js";
export type { BalancesResult, TokenBalance } from "./balances.js";
export type { HoldingsResult } from "./holdings.js";
// BEP-677 scaled-UI-amount building blocks.
export {
  applyUiMultiplier,
  SCALED_UI_AMOUNT_INTERFACE_ID,
  SCALED_UI_AMOUNT_PENDING_INTERFACE_ID,
  UI_MULTIPLIER_ONE,
} from "./internal/tokenBalances.js";

export {
  signerFromPrivateKey,
  createPrivateKeySigner,
} from "./internal/signer.js";
export type { Signer, SignerType } from "./internal/signer.js";

export {
  createPasskey,
  createHeadlessPasskey,
  signerFromPasskey,
  isPasskeySigner,
} from "./internal/passkey.js";
export type {
  PasskeySigner,
  PasskeyCredential,
  PasskeyWebAuthnFns,
} from "./internal/passkey.js";

export type {
  Session,
  SessionPermissions,
  CallPermission,
  SpendPermission,
  GrantSessionOptions,
  GrantSessionResult,
  GrantSessionStatus,
  RegistryWriteReport,
  CacheSyncReport,
  SerializedSession,
  SerializedCallPermission,
} from "./internal/sessions.js";
export type { RevokeSessionResult } from "./revokeSession.js";
// The safe persistence path for sessions: serializeSession stores everything
// but the secret; deserializeSession rebuilds a signing Session from the
// stored half plus the key the caller kept.
export { serializeSession, deserializeSession } from "./internal/sessions.js";

// Lazy KeyStore registration for sessions granted with `register: false`.
export { registerSessionKey } from "./registerSessionKey.js";
export type { RegisterSessionKeyResult } from "./registerSessionKey.js";

export type { Wallet, ExecuteResult } from "./internal/types.js";
export {
  ETHEREUM,
  BNB,
  BASE,
  BNB_TESTNET,
  SEPOLIA,
  CELO_SEPOLIA,
  CELO,
  registryNetwork,
  RELAY_URL,
  TESTNET_RELAY_URL,
} from "./config.js";
export type { NetworkConfig, L2CacheConfig, KeyStoreRegistry } from "./config.js";

// Cached-registry helpers (Celo Sepolia, Celo): is the network cached, where
// is its cache, and which chains a wallet is provisioned on.
export {
  isCachedRegistry,
  keyStoreCacheOf,
  provisioningNetworks,
} from "./internal/cachedRegistry.js";

// Testnet faucet helper — funds an EOA with native tokens via the testnet
// relay's faucet. Works only on networks whose relay exposes it (BSC testnet).
export { fundNative, waitForBalance } from "./internal/relay.js";
// Test-network faucets by chainId, for funding hints.
export {
  FAUCET_URLS,
  faucetHint,
  CELO_SEPOLIA_FAUCET_URL,
  BNB_TESTNET_FAUCET_URL,
  SEPOLIA_FAUCET_URL,
} from "./internal/relay.js";

// ERC-1271 order signing (session keys signing off-chain authorizations).
export { signOrder, signOrderTypedData } from "./signOrder.js";
export {
  approveSignatureChecker,
  revokeSignatureChecker,
} from "./approveSignatureChecker.js";

// x402 payments (Permit2 + EIP-3009).
export {
  fetchWithX402,
  selectX402Requirement,
  signX402Payment,
  buildPermit2TypedData,
  buildPermit2WitnessTypedData,
  buildEip3009TypedData,
  encodeXPaymentHeader,
  networkToChainId,
  normalizeResource,
  PERMIT2_ADDRESS,
} from "./x402.js";
export type {
  X402Resource,
  X402Requirement,
  X402PaymentPayload,
  SignX402Options,
  FetchWithX402Options,
  Permit2PaymentInput,
  Permit2WitnessInput,
  Eip3009PaymentInput,
} from "./x402.js";
export { approveTokenForPermit2 } from "./approveTokenForPermit2.js";

export {
  syncKeyToL2,
  ensureKeyCached,
  readCachedKey,
  isCachedKeyValid,
  buildPopulateKeyCall,
  waitForL1Anchor,
  readL1Anchor,
  computeKeyPackedSlot,
} from "./syncKeyToL2.js";
export type {
  SyncKeyToL2Args,
  SyncKeyToL2Result,
  EnsureKeyCachedArgs,
  EnsureKeyCachedStatus,
  CachedKey,
  L1Anchor,
  WaitForL1AnchorArgs,
  BuildPopulateKeyCallArgs,
  PopulateKeyCall,
} from "./syncKeyToL2.js";

// Cached networks: prove a session's registry state into the network's
// KeyStoreCache as a wallet call through the relay.
export { syncSessionToCache } from "./syncSessionToCache.js";
export type {
  SyncSessionToCacheOptions,
  SyncSessionToCacheResult,
  SyncSessionToCacheStatus,
} from "./syncSessionToCache.js";

export {
  ERC8183_ADDRESSES,
  JOB_STATUS,
  erc8183Addresses,
  erc8183ExpiredAt,
  buildHireCalls,
  buildClaimRefundCall,
  buildSubmitCall,
  getErc8183Job,
  getErc8183DeliverableUrl,
  hireErc8183Agent,
  settleErc8183Job,
  submitErc8183Deliverable,
  encodeErc8183Manifest,
  erc8183ManifestHash,
  verifyErc8183ManifestText,
  erc8183SubmitPermissions,
} from "./erc8183.js";
export type {
  Erc8183Addresses,
  Erc8183Job,
  Erc8183DeliverableManifest,
  HireAgentParams,
  HireAgentResult,
  HireCallsInput,
  JobStatusName,
  SubmitCallInput,
  SubmitDeliverableParams,
  SubmitDeliverableResult,
} from "./erc8183.js";

// ERC-8004 agent identity — mint and maintain an agent's on-chain identity.
// The registry address is the one already in ERC8183_ADDRESSES.registry.
export {
  buildErc8004RegisterCall,
  buildErc8004SetAgentUriCall,
  erc8004RegisterPermissions,
  registerErc8004Agent,
  setErc8004AgentUri,
  getErc8004Agent,
  encodeErc8004AgentUri,
  decodeErc8004AgentUri,
  withErc8004Registration,
} from "./erc8004.js";
export type {
  Erc8004MetadataEntry,
  Erc8004RegistrationFile,
  RegisterAgentParams,
  RegisterAgentResult,
  SetAgentUriParams,
} from "./erc8004.js";
