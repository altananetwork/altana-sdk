/**
 * ERC-8183 buyer support — hire BNB Agent Studio (and other ERC-8183 seller)
 * agents from an Altana wallet.
 *
 * ERC-8183 is the BNB agent economy's job-escrow rail: the buyer (Client)
 * creates and funds a Job in $U on the AgenticCommerce kernel, the seller
 * (Provider) submits a deliverable, and after an optimistic dispute window
 * `settle` releases the escrow. Three contracts are involved:
 *
 *  - **AgenticCommerce** ("commerce") — escrow + job state machine.
 *  - **EvaluatorRouter** ("router") — set as every job's evaluator AND hook.
 *  - **OptimisticPolicy** ("policy") — silence-approves verdict engine.
 *
 * The buyer's five on-chain actions (createJob → registerJob → setBudget →
 * approve $U → fund) are ordinary contract calls, so an Altana wallet drives
 * them through `execute` — batched into a single atomic intent via the relay
 * (gas handled), signed by the admin key or a scoped session key. Studio
 * buyers need five self-paid transactions for the same flow.
 */

import { encodeFunctionData, type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import { execute, type ExecuteOptions } from "./execute.js";
import { buildPublicClient, type Call } from "./internal/relay.js";
import type { Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";
import type { ExecuteResult, Wallet } from "./internal/types.js";

/** Per-network deployment of the ERC-8183 stack (from the bnbagent registry). */
export type Erc8183Addresses = {
  commerce: Address;
  router: Address;
  policy: Address;
  /** ERC-8004 identity registry (seller discovery). */
  registry: Address;
  /** $U (United Stables) — the payment token the kernel escrows. */
  paymentToken: Address;
};

export const ERC8183_ADDRESSES: Record<number, Erc8183Addresses> = {
  56: {
    commerce: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6",
    router: "0x51895229E12F9876011789B04f8698af06cCD6DA",
    policy: "0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5",
    registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    paymentToken: "0xcE24439F2D9C6a2289F741120FE202248B666666",
  },
  97: {
    commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE",
    router: "0xD7d36D66d2F1B608A0F943f722D27e3744f66F25",
    policy: "0x4F4678D4439feC812Ac7674Bb3Efb4C8f5Fb78A6",
    registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
  },
};

/** Job status enum — order-locked with the AgenticCommerce kernel. */
export const JOB_STATUS = ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"] as const;
export type JobStatusName = (typeof JOB_STATUS)[number];

export type Erc8183Job = {
  id: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  description: string;
  budget: bigint;
  expiredAt: bigint;
  status: number;
  statusName: JobStatusName;
  hook: Address;
  submittedAt: bigint;
  /** 32 zero-bytes until the seller submits. */
  deliverable: Hex;
};

const COMMERCE_ABI = [
  { name: "createJob", type: "function", stateMutability: "nonpayable", inputs: [{ name: "provider", type: "address" }, { name: "evaluator", type: "address" }, { name: "expiredAt", type: "uint256" }, { name: "description", type: "string" }, { name: "hook", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "setBudget", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "fund", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "expectedBudget", type: "uint256" }, { name: "optParams", type: "bytes" }], outputs: [] },
  { name: "claimRefund", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { name: "getJob", type: "function", stateMutability: "view", inputs: [{ name: "jobId", type: "uint256" }], outputs: [{ type: "tuple", components: [
    { name: "id", type: "uint256" }, { name: "client", type: "address" }, { name: "provider", type: "address" },
    { name: "evaluator", type: "address" }, { name: "description", type: "string" }, { name: "budget", type: "uint256" },
    { name: "expiredAt", type: "uint256" }, { name: "status", type: "uint8" }, { name: "hook", type: "address" },
    { name: "submittedAt", type: "uint256" }, { name: "deliverable", type: "bytes32" },
  ] }] },
  { name: "jobCounter", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "paymentToken", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const ROUTER_ABI = [
  { name: "registerJob", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "policy", type: "address" }], outputs: [] },
  { name: "settle", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }, { name: "evidence", type: "bytes" }], outputs: [] },
] as const;

const POLICY_ABI = [
  { name: "dispute", type: "function", stateMutability: "nonpayable", inputs: [{ name: "jobId", type: "uint256" }], outputs: [] },
  { name: "disputeWindow", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
] as const;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const POLICY_INITIALISED_EVENT = {
  type: "event",
  name: "JobInitialised",
  inputs: [
    { name: "jobId", type: "uint256", indexed: true },
    { name: "deliverable", type: "bytes32", indexed: false },
    { name: "submittedAt", type: "uint64", indexed: false },
    { name: "optParams", type: "bytes", indexed: false },
  ],
} as const;

export function erc8183Addresses(chainId: number): Erc8183Addresses {
  const addresses = ERC8183_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`erc8183: no deployment registered for chainId ${chainId} (known: ${Object.keys(ERC8183_ADDRESSES).join(", ")}).`);
  }
  return addresses;
}

/** Inputs for the atomic hire batch. */
export type HireCallsInput = {
  addresses: Erc8183Addresses;
  /** The predicted jobId — `jobCounter() + 1` (job ids are 1-indexed). */
  jobId: bigint;
  provider: Address;
  /** Job description — the task text (or an anchored signed quote), ≤4096 bytes. */
  description: string;
  /** Budget in raw $U units (18 decimals). */
  budget: bigint;
  /** Absolute unix seconds; must exceed now + disputeWindow. */
  expiredAt: bigint;
};

/**
 * The buyer's five calls as one atomic batch: createJob, registerJob (binds
 * the policy), setBudget, approve $U to the kernel, fund. The jobId every
 * later call targets is predicted from `jobCounter() + 1`; if another job is
 * created in the same block the batch reverts harmlessly (registerJob is
 * client-only) — re-read the counter and retry.
 */
export function buildHireCalls(input: HireCallsInput): Call[] {
  if (new TextEncoder().encode(input.description).length > 4096) {
    throw new Error("erc8183: description exceeds 4096 bytes (kernel limit — do not truncate signed quotes).");
  }
  const { addresses: a, jobId } = input;
  return [
    { to: a.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "createJob", args: [input.provider, a.router, input.expiredAt, input.description, a.router] }) },
    { to: a.router, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [jobId, a.policy] }) },
    { to: a.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [jobId, input.budget, "0x"] }) },
    { to: a.paymentToken, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [a.commerce, input.budget] }) },
    { to: a.commerce, data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [jobId, input.budget, "0x"] }) },
  ];
}

/** Read a job from the kernel. */
export async function getErc8183Job(network: NetworkConfig, jobId: bigint): Promise<Erc8183Job> {
  const publicClient = buildPublicClient(network);
  const addresses = erc8183Addresses(network.chainId);
  const job = await publicClient.readContract({
    address: addresses.commerce,
    abi: COMMERCE_ABI,
    functionName: "getJob",
    args: [jobId],
  });
  return {
    ...job,
    statusName: JOB_STATUS[job.status] ?? ("UNKNOWN" as JobStatusName),
  };
}

/**
 * Locate the deliverable URL for a SUBMITTED/COMPLETED job: find the policy's
 * JobInitialised event near the submit block and parse its optParams JSON
 * (`{"deliverable_url": …}`). Scans logs in bounded windows (public BSC RPCs
 * cap getLogs ranges).
 */
export async function getErc8183DeliverableUrl(
  network: NetworkConfig,
  jobId: bigint,
  opts: { scanWindow?: bigint; maxWindows?: number } = {},
): Promise<string | undefined> {
  const publicClient = buildPublicClient(network);
  const addresses = erc8183Addresses(network.chainId);
  const job = await getErc8183Job(network, jobId);
  if (job.submittedAt === 0n) return undefined;

  const window = opts.scanWindow ?? 1000n;
  const maxWindows = opts.maxWindows ?? 200;
  let toBlock = await publicClient.getBlockNumber();
  for (let i = 0; i < maxWindows && toBlock > 0n; i++) {
    const fromBlock = toBlock > window ? toBlock - window : 0n;
    const logs = await publicClient.getLogs({
      address: addresses.policy,
      event: POLICY_INITIALISED_EVENT,
      args: { jobId },
      fromBlock,
      toBlock,
    });
    if (logs.length > 0) {
      const optParams = logs[0]!.args.optParams;
      if (!optParams || optParams === "0x") return undefined;
      try {
        const decoded = Buffer.from(optParams.slice(2), "hex").toString("utf8");
        const parsed = JSON.parse(decoded.replace(/\0+$/, ""));
        return typeof parsed.deliverable_url === "string" ? parsed.deliverable_url : undefined;
      } catch {
        return undefined;
      }
    }
    // The event was emitted at submit time; stop once we scan past it.
    const submitBlockReached = await publicClient.getBlock({ blockNumber: fromBlock }).then(
      (b) => b.timestamp < job.submittedAt,
      () => false,
    );
    if (submitBlockReached) break;
    toBlock = fromBlock - 1n;
  }
  return undefined;
}

export type HireAgentParams = {
  provider: Address;
  /** The task text (Mode A) or an anchored signed-quote JSON (Mode B). */
  task: string;
  /** Budget in raw $U units (18 decimals). */
  budget: bigint;
  /**
   * Extra submission time beyond the policy's dispute window, seconds
   * (default 1800 — mirrors `bag erc8183 buy --deadline-min 30`).
   */
  deadlineSeconds?: number;
};

export type HireAgentResult = ExecuteResult & {
  jobId: bigint;
  provider: Address;
  budget: bigint;
  expiredAt: bigint;
};

/**
 * Hire an ERC-8183 seller: fund a job against `provider` for `budget` $U in
 * ONE atomic relay intent (five calls batched). Returns once the job is
 * FUNDED on-chain — unless `opts.noWait` is set, in which case it resolves
 * as soon as the relay accepts the intent (`result.status === "PENDING"`)
 * and the FUNDED/ownership check below is skipped, since the batch isn't
 * mined yet to check. Callers using `noWait` are responsible for verifying
 * (e.g. via `getErc8183Job`) once their `callsId` confirms.
 *
 * Overloads mirror `execute`: admin path (wallet + signer) or session path.
 */
export function hireErc8183Agent(
  wallet: Wallet,
  signer: Signer,
  params: HireAgentParams,
  opts: ExecuteOptions,
): Promise<HireAgentResult>;
export function hireErc8183Agent(
  session: Session,
  params: HireAgentParams,
  opts: ExecuteOptions,
): Promise<HireAgentResult>;
export async function hireErc8183Agent(
  walletOrSession: Wallet | Session,
  signerOrParams: Signer | HireAgentParams,
  paramsOrOpts?: HireAgentParams | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<HireAgentResult> {
  const isSessionCall = "walletAddress" in walletOrSession;
  const params = (isSessionCall ? signerOrParams : paramsOrOpts) as HireAgentParams;
  const opts = (isSessionCall ? paramsOrOpts : maybeOpts) as ExecuteOptions;
  const walletAddress = isSessionCall
    ? (walletOrSession as Session).walletAddress
    : (walletOrSession as Wallet).address;

  const network = opts.network;
  const addresses = erc8183Addresses(network.chainId);
  const publicClient = buildPublicClient(network);

  const [disputeWindow, jobCounter] = await Promise.all([
    publicClient.readContract({ address: addresses.policy, abi: POLICY_ABI, functionName: "disputeWindow" }),
    publicClient.readContract({ address: addresses.commerce, abi: COMMERCE_ABI, functionName: "jobCounter" }),
  ]);

  const jobId = jobCounter + 1n;
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(disputeWindow) + BigInt(params.deadlineSeconds ?? 1800);

  const calls = buildHireCalls({
    addresses,
    jobId,
    provider: params.provider,
    description: params.task,
    budget: params.budget,
    expiredAt,
  });

  const result = isSessionCall
    ? await execute(walletOrSession as Session, calls, opts)
    : await execute(walletOrSession as Wallet, signerOrParams as Signer, calls, opts);

  // Post-check: confirm the predicted jobId is ours and FUNDED (a concurrent
  // createJob in the same block would have reverted the batch — but verify).
  // Only meaningful once the batch has actually landed on-chain: with
  // opts.noWait, execute() returns PENDING immediately after the relay
  // *accepts* the intent, before it's mined, so getErc8183Job would read
  // pre-inclusion state and this check would false-positive on every call.
  // Skip it for PENDING; the caller is responsible for verifying once the
  // callsId they got back has confirmed.
  if (result.status === "CONFIRMED") {
    const job = await getErc8183Job(network, jobId);
    if (job.client.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(
        `erc8183: job ${jobId} is not ours after funding (client=${job.client}) — a concurrent job stole the predicted id; retry.`,
      );
    }
  }
  return { ...result, jobId, provider: params.provider, budget: params.budget, expiredAt };
}

/**
 * Release (or contest) a job's escrow. "approve" calls Router.settle — valid
 * once the dispute window after submission has elapsed; "dispute" calls
 * Policy.dispute — client-only, valid only INSIDE the window.
 */
export function settleErc8183Job(
  wallet: Wallet,
  signer: Signer,
  params: { jobId: bigint; action?: "approve" | "dispute" },
  opts: ExecuteOptions,
): Promise<ExecuteResult>;
export function settleErc8183Job(
  session: Session,
  params: { jobId: bigint; action?: "approve" | "dispute" },
  opts: ExecuteOptions,
): Promise<ExecuteResult>;
export async function settleErc8183Job(
  walletOrSession: Wallet | Session,
  signerOrParams: Signer | { jobId: bigint; action?: "approve" | "dispute" },
  paramsOrOpts?: { jobId: bigint; action?: "approve" | "dispute" } | ExecuteOptions,
  maybeOpts?: ExecuteOptions,
): Promise<ExecuteResult> {
  const isSessionCall = "walletAddress" in walletOrSession;
  const params = (isSessionCall ? signerOrParams : paramsOrOpts) as { jobId: bigint; action?: "approve" | "dispute" };
  const opts = (isSessionCall ? paramsOrOpts : maybeOpts) as ExecuteOptions;
  const addresses = erc8183Addresses(opts.network.chainId);

  const call: Call =
    (params.action ?? "approve") === "approve"
      ? { to: addresses.router, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "settle", args: [params.jobId, "0x"] }) }
      : { to: addresses.policy, data: encodeFunctionData({ abi: POLICY_ABI, functionName: "dispute", args: [params.jobId] }) };

  return isSessionCall
    ? execute(walletOrSession as Session, call, opts)
    : execute(walletOrSession as Wallet, signerOrParams as Signer, call, opts);
}

/** Reclaim escrow from a job whose seller never delivered (after expiredAt). */
export function buildClaimRefundCall(chainId: number, jobId: bigint): Call {
  const addresses = erc8183Addresses(chainId);
  return {
    to: addresses.commerce,
    data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "claimRefund", args: [jobId] }),
  };
}
