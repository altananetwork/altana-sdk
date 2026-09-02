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
  ClientUniswapV4WriteOptions,
  ClientApproveUniswapV4PairOptions,
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
  PasskeyWebAuthnFns,
} from "./internal/passkey.js";

export type {
  Session,
  SessionPermissions,
  CallPermission,
  SpendPermission,
  GrantSessionOptions,
  GrantSessionResult,
  SerializedSession,
  SerializedCallPermission,
} from "./internal/sessions.js";
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

// Uniswap v4 liquidity — an agent on a scoped session manages LP positions in
// the user's own wallet: addresses, the single-selector permission, call
// builders for mint / increase / decrease / collect / burn, reads, and the
// concentrated-liquidity math that sizes a position.
export {
  UNISWAP_V4_ADDRESSES,
  NATIVE_CURRENCY,
  V4_ACTIONS,
  uniswapV4Addresses,
  uniswapV4LiquidityPermissions,
  sortCurrencies,
  poolId,
  encodeUnlockData,
  buildModifyLiquiditiesCall,
  buildMintPositionCall,
  buildIncreaseLiquidityCall,
  buildDecreaseLiquidityCall,
  buildCollectFeesCall,
  buildBurnPositionCall,
  buildPermit2ApproveCall,
  readUniswapV4Pool,
  readUniswapV4Position,
  decodePositionInfo,
  findMintedTokenId,
  mintUniswapV4Position,
  increaseUniswapV4Liquidity,
  decreaseUniswapV4Liquidity,
  collectUniswapV4Fees,
  burnUniswapV4Position,
  approveUniswapV4Pair,
} from "./uniswapV4.js";
export type {
  UniswapV4Addresses,
  PoolKey,
  PoolState,
  PositionState,
  MintPositionInput,
  MintPositionParams,
  MintPositionResult,
  IncreaseLiquidityInput,
  IncreaseLiquidityParams,
  DecreaseLiquidityInput,
  DecreaseLiquidityParams,
  CollectFeesParams,
  BurnPositionInput,
  BurnPositionParams,
} from "./uniswapV4.js";
export {
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  Q96,
  getSqrtPriceAtTick,
  nearestUsableTick,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getLiquidityForAmounts,
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
} from "./internal/uniswapV4Math.js";
