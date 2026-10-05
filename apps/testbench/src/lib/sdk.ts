import {
  createClient,
  type Client,
  type CallsQuote,
  type ClientExecuteOptions,
  type ClientGrantSessionOptions,
  type ClientQuoteGrantSessionOptions,
  type ClientQuoteRevokeSessionOptions,
  type ClientRevokeSessionOptions,
  type ExecuteResult,
  type FeeCurrenciesResult,
  type GrantSessionResult,
  type HoldingsResult,
  type NetworkConfig,
  type PasskeySigner,
  type RevokeSessionResult,
  type SessionQuote,
  type Signer,
  type Session,
  buildPopulateKeyCall,
  approveSignatureChecker,
  approveTokenForPermit2,
  fetchWithX402,
  getErc8004Agent,
  PERMIT2_ADDRESS,
  networkByChainId,
  registerErc8004Agent,
} from "@altananetwork/sdk";
import type { Address, Hex } from "viem";
import { relayReason } from "./errors";
import { entry, type LogEntry } from "./log";
import type { MirrorReading } from "./mirror";
import { cachedNetworkFor, mirrorTargetsOf, publicClientFor, readMirror } from "./mirrorReads";
import { APPROVED_CHECKERS_ABI } from "./permit2Setup";

const ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** The slice of the SDK client the panels use. Tests provide a fake. */
export interface TestbenchClient {
  readonly chains: readonly NetworkConfig[];
  createWallet(signer: Signer): Promise<{ address: Address }>;
  /** Prompts WebAuthn for a fresh passkey and provisions one address on every configured chain. */
  createPasskeyWallet(opts: { name: string }): Promise<{ address: Address; signer: PasskeySigner }>;
  /** Finds the wallet from an existing passkey, with no stored state. */
  recoverFromPasskey(): Promise<{ address: Address; signer: PasskeySigner }>;
  holdings(wallet: Address, chainId: number): Promise<HoldingsResult>;
  feeCurrencies(chainId: number): Promise<FeeCurrenciesResult>;
  execute(opts: ClientExecuteOptions): Promise<ExecuteResult>;
  quoteExecute(opts: ClientExecuteOptions): Promise<CallsQuote>;
  grantSession(opts: ClientGrantSessionOptions): Promise<GrantSessionResult>;
  quoteGrantSession(opts: ClientQuoteGrantSessionOptions): Promise<SessionQuote>;
  quoteRevokeSession(opts: ClientQuoteRevokeSessionOptions): Promise<SessionQuote>;
  revokeSession(opts: ClientRevokeSessionOptions): Promise<RevokeSessionResult>;
  /** Both things the Permit2 rail needs: the token allowance and the session's approved checkers. */
  permit2Readiness(opts: {
    chainId: number;
    wallet: Address;
    token: Address;
    sessionKeyHash: Hex;
  }): Promise<{ tokenAllowance: bigint; checkers: readonly Address[] }>;
  /** Approves Permit2 to pull this token, as a wallet call through the relay. */
  approvePermit2Token(opts: {
    chainId: number;
    wallet: Address;
    signer: Signer;
    token: Address;
  }): Promise<ExecuteResult>;
  /**
   * Approves Permit2 to validate this session's ERC-1271 signatures. Signed by
   * the **admin**, not the session: setSignatureCheckerApproval is onlyThis, so
   * it runs as a self-call inside an admin-signed intent.
   */
  approvePermit2Checker(opts: {
    chainId: number;
    wallet: Address;
    signer: Signer;
    session: Session;
  }): Promise<ExecuteResult>;
  /** Reads an ERC-8004 identity: its owner and the record it points at. */
  getErc8004Agent(opts: { chainId: number; agentId: bigint }): Promise<{ owner: Address; agentUri: string }>;
  /** Mints an ERC-8004 identity for the wallet and returns the id the registry assigned. */
  registerErc8004Agent(opts: {
    chainId: number;
    wallet: Address;
    signer: Signer;
    agentUri: string;
  }): Promise<{ agentId: bigint; status: string; transactionHash?: Hex }>;
  /** Pays a 402 with a granted session and returns the seller's answer. */
  fetchWithX402(opts: {
    session: Session;
    url: string;
    init?: RequestInit;
    preferRail?: "permit2" | "eip3009";
    chainId?: number;
  }): Promise<Response>;
  /** One reading of the Celo mirror, the anchor and the KeyStore slots behind it. */
  readMirror(opts: {
    chainId: number;
    user: Address;
    keyId: Hex;
    registrationL1Block?: bigint;
  }): Promise<MirrorReading>;
  /**
   * Sends a populateKey proof for the current anchor, paid by `payer`.
   *
   * `user` is whose key is proven and `payer` is who sends and pays, and they
   * need not be the same: `populateKey` verifies a storage proof against the
   * anchored L1 block and does not look at `msg.sender`. Confirmed against the
   * deployed cache, not just its source, by static-calling it from an address
   * with no relationship to the key (2026-10-05). That is what lets the bench
   * prove a showcase key it does not own, which is also the honest version of
   * the claim: anyone can verify, not just the owner.
   */
  proveIntoMirror(opts: {
    chainId: number;
    user: Address;
    publicKey: Hex;
    payer: Address;
    signer: Signer;
  }): Promise<ExecuteResult & { l1BlockNumber: bigint }>;
}

export type Logger = (e: LogEntry) => void;

/** The configured network for a chain, or the SDK's own if it is not configured. */
function networkFor(chainId: number, chains: readonly NetworkConfig[]): NetworkConfig {
  const configured = chains.find((c) => c.chainId === chainId);
  if (configured) return configured;
  const known = networkByChainId(chainId);
  if (!known) throw new Error(`Chain ${chainId} is not a network this SDK knows.`);
  return known;
}

/** Wraps the real SDK client; every call is logged with args, result or error. */
export function createLiveClient(chains: NetworkConfig[], log: Logger): TestbenchClient {
  const client: Client = createClient({ chains, defaultChainId: chains[0]?.chainId });

  async function call<T>(method: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      log(entry(method, { args, result }));
      return result;
    } catch (err) {
      log(entry(method, { args, error: relayReason(err), level: "error" }));
      throw err;
    }
  }

  return {
    chains,
    createWallet: (signer) =>
      call("createWallet", { signer: signer.address }, async () => {
        const w = await client.createWallet({ signer });
        return { address: w.address };
      }),
    createPasskeyWallet: ({ name }) =>
      call("createPasskeyWallet", { name }, async () => {
        const w = await client.createPasskeyWallet({ name });
        return { address: w.address, signer: w.signer };
      }),
    recoverFromPasskey: () =>
      call("recoverFromPasskey", {}, async () => {
        const w = await client.recoverFromPasskey();
        return { address: w.address, signer: w.signer };
      }),
    holdings: (wallet, chainId) =>
      call("holdings", { wallet, chainId }, () => client.holdings({ wallet, chainId, includeZero: false })),
    feeCurrencies: (chainId) => call("feeCurrencies", { chainId }, () => client.feeCurrencies({ chainId })),
    execute: (opts) => call("execute", opts, () => client.execute(opts)),
    quoteExecute: (opts) => call("quoteExecute", opts, () => client.quoteExecute(opts)),
    grantSession: (opts) => call("grantSession", opts, () => client.grantSession(opts)),
    quoteGrantSession: (opts) => call("quoteGrantSession", opts, () => client.quoteGrantSession(opts)),
    quoteRevokeSession: (opts) => call("quoteRevokeSession", opts, () => client.quoteRevokeSession(opts)),
    revokeSession: (opts) => call("revokeSession", opts, () => client.revokeSession(opts)),
    permit2Readiness: ({ chainId, wallet, token, sessionKeyHash }) =>
      call("permit2Readiness", { chainId, wallet, token, sessionKeyHash }, async () => {
        const network = networkFor(chainId, chains);
        const publicClient = publicClientFor(network);
        const [tokenAllowance, checkers] = await Promise.all([
          publicClient.readContract({
            address: token,
            abi: ALLOWANCE_ABI,
            functionName: "allowance",
            args: [wallet, PERMIT2_ADDRESS],
          }) as Promise<bigint>,
          // An account that has never been deployed has no checkers to read;
          // an empty list is the right answer, not an error.
          publicClient
            .readContract({
              address: wallet,
              abi: APPROVED_CHECKERS_ABI,
              functionName: "approvedSignatureCheckers",
              args: [sessionKeyHash],
            })
            .then((c) => c as readonly Address[])
            .catch(() => [] as readonly Address[]),
        ]);
        return { tokenAllowance, checkers };
      }),
    approvePermit2Token: ({ chainId, wallet, signer, token }) =>
      call("approvePermit2Token", { chainId, wallet, token }, () =>
        approveTokenForPermit2({ address: wallet }, signer, token, { network: networkFor(chainId, chains) }),
      ),
    approvePermit2Checker: ({ chainId, wallet, signer, session }) =>
      call("approvePermit2Checker", { chainId, wallet, checker: PERMIT2_ADDRESS }, () =>
        approveSignatureChecker({ address: wallet }, signer, { session, checker: PERMIT2_ADDRESS }, {
          network: networkFor(chainId, chains),
        }),
      ),
    getErc8004Agent: ({ chainId, agentId }) =>
      call("getErc8004Agent", { chainId, agentId: agentId.toString() }, () =>
        getErc8004Agent(networkFor(chainId, chains), agentId),
      ),
    registerErc8004Agent: ({ chainId, wallet, signer, agentUri }) =>
      call("registerErc8004Agent", { chainId, wallet, agentUri }, async () => {
        const r = await registerErc8004Agent({ address: wallet }, signer, { agentUri }, {
          network: networkFor(chainId, chains),
        });
        return {
          agentId: r.agentId,
          status: r.status,
          ...(r.transactionHash ? { transactionHash: r.transactionHash } : {}),
        };
      }),
    fetchWithX402: ({ session, url, init, preferRail, chainId }) =>
      call("fetchWithX402", { url, preferRail, chainId }, () =>
        fetchWithX402(session, url, init, {
          ...(chainId !== undefined ? { chainId } : {}),
          ...(preferRail ? { preferRail } : {}),
        }),
      ),
    readMirror: ({ chainId, user, keyId, registrationL1Block }) =>
      call("readMirror", { chainId, user, keyId }, () => {
        const network = cachedNetworkFor(chainId);
        if (!network) {
          throw new Error(
            `Chain ${chainId} keeps its KeyStore locally, so it has no Celo-style mirror to read.`,
          );
        }
        return readMirror({
          network,
          user,
          keyId,
          ...(registrationL1Block !== undefined ? { registrationL1Block } : {}),
        });
      }),
    proveIntoMirror: ({ chainId, user, publicKey, payer, signer }) =>
      call("proveIntoMirror", { chainId, user, publicKey, payer }, async () => {
        const network = cachedNetworkFor(chainId);
        if (!network) throw new Error(`Chain ${chainId} has no Celo-style mirror to prove into.`);
        const { cache, registry } = mirrorTargetsOf(network);
        const l2Client = publicClientFor(network);
        const l1Client = publicClientFor(registry);

        // The anchor moves about every 20 minutes and a proof is only accepted
        // for the block it was built against, so a proof that misses its window
        // is rebuilt against the new anchor rather than reported as a failure.
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          const populate = await buildPopulateKeyCall({
            l1Client,
            l2Client,
            l1KeyStore: registry.keyStore,
            l2Cache: cache,
            user,
            publicKey,
          });
          if (populate.provenKeySlot === 0n) {
            throw new Error(
              `The Ethereum block Celo anchors (${populate.l1BlockNumber}) does not carry this key yet, so ` +
                `the proof would assert its absence and the cache would reject it. Wait for the next anchor.`,
            );
          }
          try {
            const result = await client.execute({
              wallet: { address: payer },
              signer,
              chainId,
              calls: [{ to: populate.to, value: populate.value, data: populate.data }],
            });
            if (result.status === "CONFIRMED") {
              return { ...result, l1BlockNumber: populate.l1BlockNumber };
            }
            lastError = new Error(`The relay returned ${result.status} for the proof.`);
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError ?? new Error("The proof could not be sent.");
      }),
  };
}
