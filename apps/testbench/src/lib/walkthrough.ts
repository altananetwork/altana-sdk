/**
 * The spine walkthrough: the six steps the Celo milestones have to show, as a
 * state machine that is a value rather than a pile of component state.
 *
 * The flow is the one in PLAN.md: a wallet on Celo with no ETH anywhere pays
 * its gas in a Celo token, registers its session key in the Ethereum Sepolia
 * KeyStore out of its Celo balance, and that key is then shown valid, and
 * later revoked, in the Celo mirror.
 *
 * Two rules the states exist to keep:
 *
 * 1. **Never fake a success.** Step 4 fails on every live relay today, for a
 *    known relay bug awaiting a decision
 *    (evidence/proposal-relay-funder-signature-simulation.md). A failed step
 *    carries the relay's own words and the walkthrough stops there.
 * 2. **A wait is not a failure.** The Celo mirror needs about half an hour
 *    after an Ethereum write before it can be proven. That is `waiting`, with
 *    its own copy, and it is reached on the way to success.
 */

import type { Address, Hex } from "viem";

export type StepId = "create" | "balances" | "pay" | "register" | "mirror" | "use-and-revoke";

export type StepStatus = "idle" | "running" | "waiting" | "done" | "failed" | "blocked";

export type StepState = {
  status: StepStatus;
  /** One line under the step's title: what happened, in the operator's terms. */
  detail?: string;
  /** The relay's own error, shown verbatim when a step fails. */
  error?: string;
  /** Transactions this step produced, with the chain each landed on. */
  txs?: { chainId: number; hash: Hex; label: string }[];
  /** Filled by the step that produced it, read by the ones after it. */
  data?: Record<string, unknown>;
};

export type WalkthroughState = Record<StepId, StepState>;

export const STEP_ORDER: readonly StepId[] = [
  "create",
  "balances",
  "pay",
  "register",
  "mirror",
  "use-and-revoke",
];

export const STEP_TITLES: Record<StepId, string> = {
  create: "Create an agentic wallet on Celo",
  balances: "Balances on Celo, and no ETH on Ethereum",
  pay: "Pay gas in a Celo token",
  register: "Register the session key in the Ethereum KeyStore, paid from Celo",
  mirror: "Show the key in the Celo mirror",
  "use-and-revoke": "Use the key, then revoke it",
};

export const STEP_BLURBS: Record<StepId, string> = {
  create:
    "A passkey or a private key. Either way the wallet is counterfactual until its first transaction, so nothing is on chain yet.",
  balances:
    "The wallet holds Celo tokens and zero ETH on Ethereum Sepolia. Everything after this is paid from the Celo side.",
  pay: "The relay charges its fee in whichever token you choose, and says which one it charged.",
  register:
    "One signature. The write lands on Ethereum Sepolia and its fee comes out of the wallet's Celo balance, so the wallet still holds no ETH.",
  mirror:
    "A third party on Celo can check the key without leaving Celo. The cache answers for one anchored Ethereum block, so this step has a wait in it.",
  "use-and-revoke":
    "The session key signs a transaction, then the wallet revokes it and the mirror carries the revocation.",
};

export function emptyWalkthrough(): WalkthroughState {
  return Object.fromEntries(STEP_ORDER.map((id) => [id, { status: "idle" as const }])) as WalkthroughState;
}

export function setStep(state: WalkthroughState, id: StepId, patch: StepState): WalkthroughState {
  return { ...state, [id]: patch };
}

/**
 * The step the operator should act on: the first that is not finished. A
 * `waiting` step is still the current one, because the wait is the step.
 */
export function currentStep(state: WalkthroughState): StepId | undefined {
  return STEP_ORDER.find((id) => state[id].status !== "done");
}

/**
 * Whether a step can be started. Each needs the one before it to have
 * finished, so the walkthrough reads top to bottom and a failure stops it
 * rather than letting a later step run on missing data.
 */
export function canRun(state: WalkthroughState, id: StepId): boolean {
  const index = STEP_ORDER.indexOf(id);
  if (index < 0) return false;
  if (state[id].status === "running") return false;
  return STEP_ORDER.slice(0, index).every((prev) => state[prev].status === "done");
}

/** How far the walkthrough has got, for the progress line. */
export function progress(state: WalkthroughState): { done: number; total: number; failed: boolean } {
  const done = STEP_ORDER.filter((id) => state[id].status === "done").length;
  const failed = STEP_ORDER.some((id) => state[id].status === "failed");
  return { done, total: STEP_ORDER.length, failed };
}

/** What the walkthrough produced, for the step after it and for the proof view. */
export type WalkthroughData = {
  walletAddress?: Address;
  /** The session key's public key: what the mirror card needs to prove it. */
  sessionPublicKey?: Hex;
  sessionKeyId?: Hex;
  /** The Ethereum block the registry write landed in, if the relay reported one. */
  registryBlock?: bigint;
};

export function dataOf(state: WalkthroughState): WalkthroughData {
  const out: WalkthroughData = {};
  for (const id of STEP_ORDER) {
    const d = state[id].data;
    if (!d) continue;
    if (typeof d.walletAddress === "string") out.walletAddress = d.walletAddress as Address;
    if (typeof d.sessionPublicKey === "string") out.sessionPublicKey = d.sessionPublicKey as Hex;
    if (typeof d.sessionKeyId === "string") out.sessionKeyId = d.sessionKeyId as Hex;
    if (typeof d.registryBlock === "bigint") out.registryBlock = d.registryBlock;
  }
  return out;
}
