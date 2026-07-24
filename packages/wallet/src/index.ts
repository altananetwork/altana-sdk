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
  ClientBalancesOptions,
} from "./client.js";

export type { CreateWalletOptions, CreateWalletResult } from "./createWallet.js";
export type { CreatePasskeyWalletOptions } from "./createPasskeyWallet.js";
export type { RecoverFromPasskeyOptions } from "./recoverFromPasskey.js";
export type { ExecuteOptions, Call } from "./execute.js";
export type { BalancesResult, TokenBalance } from "./balances.js";
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
} from "./internal/passkey.js";

export type {
  Session,
  SessionPermissions,
  CallPermission,
  SpendPermission,
  GrantSessionOptions,
} from "./internal/sessions.js";

// Lazy KeyStore registration for sessions granted with `register: false`.
export { registerSessionKey } from "./registerSessionKey.js";
export type { RegisterSessionKeyResult } from "./registerSessionKey.js";

export type { Wallet, ExecuteResult } from "./internal/types.js";
export {
  ETHEREUM,
  BNB,
  BASE,
  BNB_TESTNET,
  RELAY_URL,
  TESTNET_RELAY_URL,
} from "./config.js";
export type { NetworkConfig, L2CacheConfig } from "./config.js";

// Testnet faucet helper — funds an EOA with native tokens via the testnet
// relay's faucet. Works only on networks whose relay exposes it (BSC testnet).
export { fundNative, waitForBalance } from "./internal/relay.js";

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
  PERMIT2_ADDRESS,
} from "./x402.js";
export type {
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
} from "./syncKeyToL2.js";
export type {
  SyncKeyToL2Args,
  SyncKeyToL2Result,
  EnsureKeyCachedArgs,
  EnsureKeyCachedStatus,
  CachedKey,
} from "./syncKeyToL2.js";

export {
  ERC8183_ADDRESSES,
  JOB_STATUS,
  erc8183Addresses,
  buildHireCalls,
  buildClaimRefundCall,
  getErc8183Job,
  getErc8183DeliverableUrl,
  hireErc8183Agent,
  settleErc8183Job,
} from "./erc8183.js";
export type {
  Erc8183Addresses,
  Erc8183Job,
  HireAgentParams,
  HireAgentResult,
  HireCallsInput,
  JobStatusName,
} from "./erc8183.js";
