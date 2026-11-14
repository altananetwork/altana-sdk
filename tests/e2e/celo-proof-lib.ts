/**
 * The parts of the Celo live proof that touch no chain: reading the command
 * line, the guard that keeps a mainnet run deliberate, the arithmetic of the
 * charge, and the summary. Kept apart from `live-celo-proof.ts` so each can be
 * unit-tested without a relay or an RPC.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

export type ProofNetwork = "celo" | "celo-sepolia";
/** The two wallets: one that holds CELO only, one that holds USDC only. */
export type Role = "celo" | "usdc";

/** What each network must be before the script reads or signs anything. */
export const EXPECTED: Record<ProofNetwork, { chainId: number; registryChainId: number; relayUrl: string }> = {
  celo: { chainId: 42220, registryChainId: 1, relayUrl: "https://relay.altana.network" },
  "celo-sepolia": { chainId: 11142220, registryChainId: 11155111, relayUrl: "https://testnet-relay.altana.network" },
};

/** The literal flag a mainnet send needs on top of `--send`. */
export const MAINNET_FLAG = "--i-am-doris";

/** Where the session's one-cent transfer goes on mainnet unless `--send-cent-to` says otherwise: the owner's deployer. */
export const MAINNET_CENT_RECIPIENT: Address = "0x90052C7827475fCAb79089B81ea928A9Fa19BE7C";

export type ProofOptions = {
  network: ProofNetwork;
  /** False is a dry run: nothing is signed and nothing is sent. */
  send: boolean;
  /** The wallet this run is for. Required with `send`; a dry run without it looks at both. */
  wallet?: Role;
  /** Where the session's one-cent transfer goes. Defaults per network. */
  sendCentTo?: Address;
  /** Return what the wallet holds here at the end. Unset, nothing is swept: the leftovers stay in the wallet. */
  sweepTo?: Address;
  /** Continue the wallet's earlier partial run from its first step not done. */
  resume: boolean;
  /** With `resume`: start at this step instead of the first one not done. */
  from?: Step;
  /** Start over although an earlier run left a session behind. */
  discardSession: boolean;
  /** Celo Sepolia only: make new throwaway wallets instead of reusing the saved ones. */
  fresh: boolean;
  /** Celo Sepolia only: what the throwaway wallets are funded up to, as decimal amounts. */
  fundCelo: string;
  fundUsdc: string;
  /** Which RPCs the SDK client itself uses: the SDK's own, or the ones in the environment. */
  clientRpc: "default" | "env";
  /** The relay's conversion margin and how far from it a measured one may be. */
  marginBps: number;
  marginToleranceBps: number;
  /** Directory for the JSON record and the session files. */
  outDir?: string;
};

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export const USAGE = [
  "bun run live:celo-proof -- --network <celo|celo-sepolia> [--wallet <celo|usdc>] [--send]",
  "",
  "  --network <celo|celo-sepolia>   required",
  "  --wallet <celo|usdc>            the wallet to run. Required with --send; a dry run without it shows both.",
  "  --send                          sign and send. Without it this is a dry run.",
  `  ${MAINNET_FLAG}                    required with --send on --network celo`,
  `  --send-cent-to <address>        where the session's one-cent transfer goes (celo: ${MAINNET_CENT_RECIPIENT}; celo-sepolia: the testnet funder)`,
  "  --sweep-to <address>            return what the wallet holds here at the end. Without it nothing is swept.",
  "  --resume                        continue the wallet's earlier partial run",
  "  --from <step>                   with --resume: start at this step (for example revoke) instead of the first not done",
  "  --discard-session               start over although an earlier run left a session behind",
  "  --fresh                         celo-sepolia: new throwaway wallets",
  "  --fund-celo <n>, --fund-usdc <n>  celo-sepolia: fund the throwaway wallets up to these amounts (3 and 7)",
  "  --client-rpc <default|env>      RPCs of the SDK client: the SDK's own (default) or the environment's",
  "  --margin-bps <n>                the relay's conversion margin (200)",
  "  --margin-tolerance-bps <n>      how far a measured margin may be from it (25)",
  "  --out <dir>                     where the JSON record goes (tests/e2e/.out)",
].join("\n");

const VALUE_FLAGS = new Set([
  "--network",
  "--wallet",
  "--send-cent-to",
  "--sweep-to",
  "--from",
  "--fund-celo",
  "--fund-usdc",
  "--client-rpc",
  "--margin-bps",
  "--margin-tolerance-bps",
  "--out",
]);
const BOOLEAN_FLAGS = new Set(["--send", MAINNET_FLAG, "--resume", "--discard-session", "--fresh"]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Reads the command line. Strict on purpose: an unknown or misspelled flag is
 * an error, so `--sned` can never turn into a silent dry run or, worse, a flag
 * that was meant to hold a run back being ignored.
 */
export function parseProofArgs(argv: readonly string[]): ProofOptions {
  const values = new Map<string, string>();
  const set = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const [flag, inline] = raw.includes("=") ? [raw.slice(0, raw.indexOf("=")), raw.slice(raw.indexOf("=") + 1)] : [raw, undefined];
    if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value.`);
      if (values.has(flag)) throw new UsageError(`${flag} was given twice.`);
      values.set(flag, value);
    } else if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) throw new UsageError(`${flag} takes no value.`);
      set.add(flag);
    } else {
      throw new UsageError(`Unknown argument ${raw}.`);
    }
  }

  const network = values.get("--network");
  if (network !== "celo" && network !== "celo-sepolia") {
    throw new UsageError("--network must be celo or celo-sepolia.");
  }
  const send = set.has("--send");
  if (send && network === "celo" && !set.has(MAINNET_FLAG)) {
    throw new UsageError(
      `Refusing to send on Celo mainnet without ${MAINNET_FLAG}. This spends real funds; only the owner runs it.`,
    );
  }
  const wallet = values.get("--wallet");
  if (wallet !== undefined && wallet !== "celo" && wallet !== "usdc") throw new UsageError("--wallet must be celo or usdc.");
  if (send && !wallet) throw new UsageError("--send runs one wallet at a time: pass --wallet celo or --wallet usdc.");

  for (const flag of ["--resume", "--discard-session", "--fresh"]) {
    if (set.has(flag) && !send) throw new UsageError(`${flag} only means something with --send.`);
  }
  if (values.has("--sweep-to") && !send) throw new UsageError("--sweep-to only means something with --send.");
  if (set.has("--fresh") && network !== "celo-sepolia") {
    throw new UsageError("--fresh makes throwaway wallets, which only exist on celo-sepolia.");
  }
  for (const flag of ["--fund-celo", "--fund-usdc"]) {
    if (values.has(flag) && network !== "celo-sepolia") {
      throw new UsageError(`${flag} funds throwaway wallets from the testnet funder; it does nothing on celo.`);
    }
  }
  if (set.has("--resume") && (set.has("--discard-session") || set.has("--fresh"))) {
    throw new UsageError("--resume continues the earlier run; it cannot be combined with --discard-session or --fresh.");
  }

  const address = (flag: string): Address | undefined => {
    const raw = values.get(flag);
    if (raw === undefined) return undefined;
    if (!isAddress(raw, { strict: false }) || raw.toLowerCase() === ZERO_ADDRESS) {
      throw new UsageError(`${flag} ${raw} is not an address funds can be sent to.`);
    }
    return getAddress(raw);
  };
  const sendCentTo = address("--send-cent-to");
  const sweepTo = address("--sweep-to");

  const from = values.get("--from");
  if (from !== undefined) {
    if (!set.has("--resume")) throw new UsageError("--from names where a resumed run starts; it needs --resume.");
    if (!(STEPS as readonly string[]).includes(from) || from === "grant") {
      throw new UsageError(`--from must be one of ${STEPS.filter((s) => s !== "grant").join(", ")}.`);
    }
    if (from === "sweep" && !sweepTo) throw new UsageError("--from sweep needs --sweep-to <address>.");
  }

  const clientRpc = values.get("--client-rpc") ?? "default";
  if (clientRpc !== "default" && clientRpc !== "env") throw new UsageError("--client-rpc must be default or env.");

  const amount = (flag: string, fallback: string): string => {
    const v = values.get(flag) ?? fallback;
    if (!/^\d+(\.\d+)?$/.test(v)) throw new UsageError(`${flag} ${v} is not an amount.`);
    return v;
  };
  const bps = (flag: string, fallback: number): number => {
    const v = values.get(flag);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v)) throw new UsageError(`${flag} ${v} is not a whole number of basis points.`);
    return Number(v);
  };

  const out = values.get("--out");
  return {
    network,
    send,
    ...(wallet ? { wallet } : {}),
    ...(sendCentTo ? { sendCentTo } : {}),
    ...(sweepTo ? { sweepTo } : {}),
    resume: set.has("--resume"),
    ...(from ? { from: from as Step } : {}),
    discardSession: set.has("--discard-session"),
    fresh: set.has("--fresh"),
    fundCelo: amount("--fund-celo", "3"),
    fundUsdc: amount("--fund-usdc", "7"),
    clientRpc,
    marginBps: bps("--margin-bps", 200),
    marginToleranceBps: bps("--margin-tolerance-bps", 25),
    ...(out ? { outDir: out } : {}),
  };
}

/**
 * Refuses a recipient for the session's one-cent transfer that cannot work.
 * A session key cannot call its own account, and the other test wallet must
 * not receive anything: the USDC wallet has to stay free of CELO.
 */
export function assertCentRecipient(to: Address, wallets: Record<Role, Address>, role: Role): void {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(to, wallets[role])) {
    throw new UsageError(`The one-cent transfer cannot go to the wallet itself (${to}): a session key cannot call its own account.`);
  }
  const other: Role = role === "celo" ? "usdc" : "celo";
  if (same(to, wallets[other])) {
    throw new UsageError(`The one-cent transfer cannot go to the other test wallet (${to}): the USDC wallet has to stay free of CELO.`);
  }
}

/**
 * Refuses a network config that is not the one the flag named. Run before
 * anything is read, so a wrong constant or an overridden relay URL can never
 * point a "celo" run somewhere else.
 */
export function assertIdentity(
  network: ProofNetwork,
  config: { chainId: number; relayUrl?: string; registryChainId: number },
): void {
  const want = EXPECTED[network];
  if (config.chainId !== want.chainId) {
    throw new Error(`--network ${network} must be chain ${want.chainId}; the config says ${config.chainId}.`);
  }
  if (config.relayUrl !== want.relayUrl) {
    throw new Error(`--network ${network} must use the relay ${want.relayUrl}; the config says ${config.relayUrl}.`);
  }
  if (config.registryChainId !== want.registryChainId) {
    throw new Error(
      `--network ${network} must keep its KeyStore on chain ${want.registryChainId}; the config says ${config.registryChainId}.`,
    );
  }
}

/** The phrase a person types to let a mainnet send go ahead. */
export const MAINNET_PHRASE = "send on celo mainnet";

/**
 * A mainnet send is confirmed by a person typing a phrase, so it needs a
 * terminal to type it at. Checked before anything is read: a script, a CI job
 * or an agent has no terminal and stops here.
 */
export function assertCanConfirm(o: Pick<ProofOptions, "network" | "send">, stdinIsTTY: boolean): void {
  if (o.send && o.network === "celo" && !stdinIsTTY) {
    throw new UsageError(
      `Sending on Celo mainnet is confirmed by typing "${MAINNET_PHRASE}" at an interactive terminal, and this is not one. Nothing was read or sent.`,
    );
  }
}

/** True when what was typed is the phrase, give or take surrounding spaces. */
export function isConfirmed(typed: string): boolean {
  return typed.trim() === MAINNET_PHRASE;
}

/** Text with every URL removed that is not on a public host: provider URLs carry keys. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("<redacted>");
  }
  return out.replace(/(https?|wss?):\/\/[^\s"')]+/g, (url) =>
    /^(https?|wss?):\/\/([a-z0-9-]+\.)*(altana\.network|publicnode\.com|celo-testnet\.org|celo\.org|celoscan\.io|etherscan\.io|bscscan\.com|0xrpc\.io|blastapi\.io|mevblocker\.io|drpc\.org)(\/|$|:)/i.test(
      url,
    )
      ? url
      : "<rpc>",
  );
}

export type DescribedError = {
  name: string;
  /** Set when the error is an AltanaError. */
  code?: string;
  message: string;
  /** The long form an AltanaError keeps for logs. */
  detail?: string;
  /** Each cause underneath, outermost first, one line each. */
  causes: string[];
};

/** Everything a thrown value says about itself, cause chain included, with URLs redacted. */
export function describeError(err: unknown, secrets: readonly (string | undefined)[] = []): DescribedError {
  const clean = (v: unknown) => redact(String(v), secrets);
  const e = err as { name?: unknown; code?: unknown; message?: unknown; detail?: unknown; cause?: unknown } | undefined;
  const causes: string[] = [];
  let cur: unknown = e?.cause;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    const c = cur as { name?: unknown; message?: unknown; cause?: unknown };
    const text = typeof c === "object" ? clean(c.message ?? JSON.stringify(c)) : clean(c);
    causes.push(`${typeof c === "object" && c.name ? String(c.name) : typeof c}: ${text.split("\n")[0]}`);
    cur = typeof c === "object" ? c.cause : undefined;
  }
  return {
    name: typeof e?.name === "string" ? e.name : typeof err,
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
    message: clean(e?.message ?? err),
    ...(typeof e?.detail === "string" ? { detail: clean(e.detail) } : {}),
    causes,
  };
}

// ── The run as a list of steps ──────────────────────────────────────────────

export const STEPS = ["grant", "execute", "register", "mirror", "charge", "revoke", "revoke-mirror", "sweep"] as const;
export type Step = (typeof STEPS)[number];
export type StepStatus = "PASS" | "FAIL" | "NOT RUN";

/** The steps a run goes through: the sweep is only one of them when somewhere to sweep to was named. */
export function stepsFor(o: Pick<ProofOptions, "sweepTo">): Step[] {
  return STEPS.filter((s) => s !== "sweep" || o.sweepTo !== undefined);
}

/** The first of `steps` an earlier run did not finish. Undefined when all are done. */
export function firstStepNotDone(done: Partial<Record<Step, StepStatus>>, steps: readonly Step[] = STEPS): Step | undefined {
  return steps.find((s) => done[s] !== "PASS");
}

/**
 * True when a failure is the wallet not holding enough to pay. The SDK says
 * so with the code `insufficient_funds` on the error or one of its causes;
 * a leg that failed in the background only keeps the SDK's sentence, which
 * for that code always reads "Not enough <token> to pay for ...".
 */
export function isInsufficientFunds(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    if (typeof cur === "string") return /Not enough \S+ to pay for /.test(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "insufficient_funds") return true;
    if (typeof e.message === "string" && /Not enough \S+ to pay for /.test(e.message)) return true;
    cur = e.cause;
  }
  return false;
}

export type SummaryRow = {
  wallet: Role;
  step: string;
  chain: string;
  /** Explorer link, or empty when the step sent nothing. */
  link: string;
  /** Seconds since that wallet's grant started. */
  seconds?: number;
  status: "PASS" | "FAIL" | "INFO" | "SKIP" | "NOT RUN";
  note?: string;
};

/** The summary as aligned text lines, one per step. */
export function summaryTable(rows: readonly SummaryRow[]): string[] {
  const cells = rows.map((r) => [
    r.wallet,
    r.step,
    r.chain,
    r.seconds === undefined ? "" : `${r.seconds.toFixed(1)}s`,
    r.status,
    [r.link, r.note].filter(Boolean).join("  "),
  ]);
  const header = ["wallet", "step", "chain", "t", "result", "transaction / note"];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(header), line(widths.map((w, i) => (i === header.length - 1 ? "-".repeat(20) : "-".repeat(w)))), ...cells.map(line)];
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/** A Chainlink `<asset>/USD` answer: USD per one whole unit of the asset. */
export type UsdPrice = { answer: bigint; decimals: number };

/** One US cent of an asset, in its base units. */
export function oneCentIn(price: UsdPrice, assetDecimals: number): bigint {
  if (price.answer <= 0n) throw new Error("oneCentIn: the price is not positive");
  return (10n ** BigInt(assetDecimals) * 10n ** BigInt(price.decimals)) / (100n * price.answer);
}

/** `amount` of one asset, expressed in another at the two USD prices. Rounds down. */
export function convert(
  amount: bigint,
  from: { decimals: number; price: UsdPrice },
  to: { decimals: number; price: UsdPrice },
): bigint {
  if (to.price.answer <= 0n) throw new Error("convert: the price is not positive");
  return (
    (amount * from.price.answer * 10n ** BigInt(to.price.decimals) * 10n ** BigInt(to.decimals)) /
    (to.price.answer * 10n ** BigInt(from.price.decimals) * 10n ** BigInt(from.decimals))
  );
}

/** USD value of an amount at a price, as a number of dollars. */
export function usdValue(amount: bigint, decimals: number, price: UsdPrice): number {
  return Number(formatUnits(amount * price.answer, decimals + price.decimals));
}

/** Dollars as text: cents above a dollar, four decimals below, where a fee of a cent would otherwise read as $0.01 or $0.00. */
export function usdText(dollars: number): string {
  return `$${dollars.toFixed(Math.abs(dollars) >= 1 ? 2 : 4)}`;
}

/** Gas the relay budgets for the root key's write and for a session key's write, its own buffer included. */
export const ROOT_WRITE_GAS = 620_000n;
export const SESSION_WRITE_GAS = 500_000n;

/**
 * What a registration will lock in the wallet's token, from live figures.
 *
 * For each write the relay's funder fronts the registration fee with the
 * SDK's 10% headroom, plus a gas budget of 1.3 times the gas limit at twice
 * the base fee plus the tip. The wallet locks that amount at the two USD
 * prices plus the relay's conversion margin. A wallet's first registration is
 * two writes, the root key and then the session key.
 *
 * An estimate: the gas figures are what the relay budgeted for these writes
 * on 2026-11-14, and it rounds up. What a run was really charged is read from
 * the chain afterwards.
 */
export function estimateRegistration(i: {
  registrationFee: bigint;
  baseFeePerGas: bigint;
  priorityFeePerGas: bigint;
  firstTime: boolean;
  native: { decimals: number; price: UsdPrice };
  token: { decimals: number; price: UsdPrice };
  marginBps: number;
}): { fronted: bigint; lock: bigint; usd: number } {
  const perGas = 2n * i.baseFeePerGas + i.priorityFeePerGas;
  const write = (gas: bigint) => (i.registrationFee * 110n) / 100n + (gas * perGas * 130n) / 100n;
  const fronted = (i.firstTime ? write(ROOT_WRITE_GAS) : 0n) + write(SESSION_WRITE_GAS);
  const lock = (convert(fronted, i.native, i.token) * BigInt(10_000 + i.marginBps)) / 10_000n;
  return { fronted, lock, usd: usdValue(lock, i.token.decimals, i.token.price) };
}

/** `(a / b - 1)` in basis points, to two decimals. */
export function overBps(a: bigint, b: bigint): number {
  if (b <= 0n) throw new Error("overBps: the base is not positive");
  return Number((a * 1_000_000n) / b - 1_000_000n) / 100;
}

/** What to send when emptying a wallet through the relay: the balance less the quoted fee with headroom. */
export function sweepAmount(balance: bigint, quotedFee: bigint, headroomPercent = 25): bigint {
  const keep = (quotedFee * BigInt(100 + headroomPercent)) / 100n;
  return balance > keep ? balance - keep : 0n;
}

// ── What a relayed transaction says about itself ────────────────────────────

const ORCHESTRATOR_ABI = parseAbi([
  "function execute(bytes encodedIntent) payable returns (bytes4)",
  "function execute(bytes[] encodedIntents) payable returns (bytes4[])",
]);

const INTENT_ABI = [
  {
    type: "tuple",
    components: [
      { name: "eoa", type: "address" },
      { name: "executionData", type: "bytes" },
      { name: "nonce", type: "uint256" },
      { name: "payer", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "paymentMaxAmount", type: "uint256" },
      { name: "combinedGas", type: "uint256" },
      { name: "encodedPreCalls", type: "bytes[]" },
      { name: "encodedFundTransfers", type: "bytes[]" },
      { name: "settler", type: "address" },
      { name: "expiry", type: "uint256" },
      { name: "isMultichain", type: "bool" },
      { name: "funder", type: "address" },
      { name: "funderSignature", type: "bytes" },
      { name: "settlerContext", type: "bytes" },
      { name: "paymentAmount", type: "uint256" },
      { name: "paymentRecipient", type: "address" },
      { name: "signature", type: "bytes" },
      { name: "paymentSignature", type: "bytes" },
      { name: "supportedAccountImplementation", type: "address" },
    ],
  },
] as const;

/** The money side of one relayed intent, read from the transaction's own calldata. */
export type IntentMoney = {
  eoa: Address;
  /** The token the relay's fee was paid in (the zero address is native). */
  paymentToken: Address;
  /** What the relay actually took as its fee. */
  paymentAmount: bigint;
  /** The most it could have taken: the fee the quote stated. */
  paymentMaxAmount: bigint;
  paymentRecipient: Address;
  combinedGas: bigint;
  /** What the relay's funder fronted to the wallet in this intent, per token. Empty on an ordinary intent. */
  funded: { token: Address; amount: bigint }[];
  funder: Address;
};

/**
 * Decodes the intents in a relay transaction's input (`Orchestrator.execute`).
 * The fee and the funder's transfers are fields of the intent, so they are
 * read exactly, with no call trace. Throws when the input is something else.
 */
export function decodeIntents(input: Hex): IntentMoney[] {
  const call = decodeFunctionData({ abi: ORCHESTRATOR_ABI, data: input });
  const encoded = (Array.isArray(call.args[0]) ? call.args[0] : [call.args[0]]) as Hex[];
  return encoded.map((bytes) => {
    const [intent] = decodeAbiParameters(INTENT_ABI, bytes);
    return {
      eoa: intent.eoa,
      paymentToken: intent.paymentToken,
      paymentAmount: intent.paymentAmount,
      paymentMaxAmount: intent.paymentMaxAmount,
      paymentRecipient: intent.paymentRecipient,
      combinedGas: intent.combinedGas,
      funded: intent.encodedFundTransfers.map((t) => {
        const [token, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], t);
        return { token, amount };
      }),
      funder: intent.funder,
    };
  });
}

// ── The charge ──────────────────────────────────────────────────────────────

/** One write on the registry chain, as its transaction and the KeyStore report it. */
export type RegistryWrite = {
  kind: "root" | "session";
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** The KeyStore's registration fee at that block, in the registry chain's native token. */
  registrationFee: bigint;
  /** What the funder fronted for it, in the registry chain's native token. */
  fronted: bigint;
  /** What the relay took as its fee on the registry chain. */
  relayFee: bigint;
};

export type ChargeInput = {
  /** The token the wallet paid in, on the funding chain. */
  token: { symbol: string; decimals: number; price: UsdPrice };
  /** The registry chain's native token. */
  native: { symbol: string; decimals: number; price: UsdPrice };
  writes: readonly RegistryWrite[];
  /** What the wallet locked in escrow on the funding chain for those writes, in `token`. */
  locked: bigint;
  /** The relay's configured conversion margin, and how far from it a measured one may be. */
  marginBps: number;
  toleranceBps: number;
};

export type ChargeReport = {
  /** Registration fees plus the gas the writes burned, in the registry chain's native token. */
  actualCost: bigint;
  /** The same at the two USD prices, in the token the wallet paid in. */
  actualCostInToken: bigint;
  /** What the funder fronted in total, in the registry chain's native token. */
  fronted: bigint;
  /** What the fronted amount is worth in the wallet's token at the two USD prices, with no margin. */
  frontedInToken: bigint;
  /** How far what the wallet locked is above `frontedInToken`: the relay's conversion margin as charged. */
  conversionMarginBps: number;
  /** How far what the wallet locked is above `actualCostInToken`. */
  overActualCostBps: number;
  /** PASS when the conversion margin is the configured one, within the tolerance. */
  verdict: "PASS" | "FAIL";
  lines: string[];
};

/**
 * What the wallet paid for the registry write against what the write cost.
 *
 * Two comparisons, and they answer different questions:
 *
 *  - The conversion. The relay's funder fronts an amount on the registry
 *    chain and the wallet locks its price in the wallet's own token. Locked
 *    over fronted-at-the-feeds is the conversion margin, which the relay
 *    configures (2%). This is the verdict.
 *  - The whole charge. What was fronted is larger than what the write cost:
 *    it carries the relay's fee on the registry chain and a gas budget the
 *    write does not use up, the rest of which stays in the wallet there.
 *    Locked over actual cost says how much more than the bare cost the user
 *    put up, and is reported, not judged.
 */
export function chargeReport(input: ChargeInput): ChargeReport {
  const { token, native, writes } = input;
  if (writes.length === 0) throw new Error("chargeReport: no registry write to compare against");
  const sum = (pick: (w: RegistryWrite) => bigint) => writes.reduce((s, w) => s + pick(w), 0n);
  const fees = sum((w) => w.registrationFee);
  const gasBurned = sum((w) => w.gasUsed * w.effectiveGasPrice);
  const relayFees = sum((w) => w.relayFee);
  const fronted = sum((w) => w.fronted);
  const actualCost = fees + gasBurned;
  const actualCostInToken = convert(actualCost, native, token);
  const frontedInToken = convert(fronted, native, token);
  if (frontedInToken <= 0n || actualCostInToken <= 0n) {
    throw new Error("chargeReport: the registry cost converts to nothing at these prices");
  }
  const conversionMarginBps = overBps(input.locked, frontedInToken);
  const overActualCostBps = overBps(input.locked, actualCostInToken);
  const verdict =
    Math.abs(conversionMarginBps - input.marginBps) <= input.toleranceBps ? ("PASS" as const) : ("FAIL" as const);

  const t = (v: bigint) => `${formatUnits(v, token.decimals)} ${token.symbol}`;
  const n = (v: bigint) => `${formatUnits(v, native.decimals)} ${native.symbol}`;
  const usd = (p: UsdPrice) => `$${formatUnits(p.answer, p.decimals)}`;
  const leftover = fronted - fees - relayFees;
  const lines = [
    `locked on the funding chain for the registry write: ${t(input.locked)}`,
    `fronted on the registry chain: ${n(fronted)} = registration fees ${n(fees)} + relay fee ${n(relayFees)} + left in the wallet ${n(leftover > 0n ? leftover : 0n)}`,
    `prices: ${native.symbol} ${usd(native.price)}, ${token.symbol} ${usd(token.price)}`,
    `fronted amount at those prices: ${t(frontedInToken)}; locked is ${(conversionMarginBps / 100).toFixed(2)}% above it` +
      ` (configured margin ${(input.marginBps / 100).toFixed(2)}%, tolerance ${(input.toleranceBps / 100).toFixed(2)}%): ${verdict}`,
    `what the write cost: registration fees ${n(fees)} + gas burned ${n(gasBurned)} = ${n(actualCost)}, or ${t(actualCostInToken)}`,
    `locked is ${(Number(input.locked * 1000n / actualCostInToken) / 1000).toFixed(2)} times that cost. The difference is the relay's fee on the registry chain, ` +
      `the unused gas budget left in the wallet there, and the conversion margin`,
  ];
  return { actualCost, actualCostInToken, fronted, frontedInToken, conversionMarginBps, overActualCostBps, verdict, lines };
}
