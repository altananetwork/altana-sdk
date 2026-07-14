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

export type { Wallet, ExecuteResult } from "./internal/types.js";
export { ETHEREUM, BNB, BASE, RELAY_URL } from "./config.js";
export type { NetworkConfig, L2CacheConfig } from "./config.js";

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
