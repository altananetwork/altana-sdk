import { formatUnits } from "viem";

/**
 * Every relay failure a wallet shows a person, as one plain sentence with what
 * to do next.
 *
 * The rule this file exists for: a basic failure is one sentence an end user
 * understands, and the next action is part of it. Everything the SDK knows
 * besides that sentence (what it was doing, the relay's raw words, the calls,
 * the balances it read) rides along as `detail`, for a debug log, and is never
 * what the screen shows.
 *
 * It lives in the SDK rather than in the relay or in each app: the relay
 * answers several clients, and an app that writes its own wording invents a
 * different sentence for the same cause. The relay's own message is still used
 * verbatim where it is the better one, which is the `unknown` case and a
 * shortfall the relay quantified and the SDK could not.
 */

/** What went wrong, as a value an app can branch on. */
export type AltanaErrorCode =
  /** The wallet cannot pay for the operation: gas, the relay fee, or value the calls send. */
  | "insufficient_funds"
  /** The relay's price for the operation aged out before it was signed and sent. */
  | "quote_expired"
  /** The session key's expiry has passed. */
  | "session_expired"
  /** The session key's spend cap does not cover this, or it has none for the token. */
  | "spend_limit_exceeded"
  /** The session key is not permitted to make the call. */
  | "call_not_permitted"
  /** No answer from the relay: the network, DNS, a proxy, or the relay being down. */
  | "relay_unreachable"
  /** The relay has no entry for the chain, so it cannot act on it. */
  | "chain_not_served"
  /** This relay has no record of the wallet, so it will not act for it. */
  | "wallet_unknown_to_relay"
  /** The relay could not price the fee, so it would not quote. */
  | "price_unavailable"
  /** Anything the map does not recognise. The relay's own words lead. */
  | "unknown";

/** A token amount, in its own base units, with what it takes to read it. */
export type TokenAmount = { symbol: string; decimals: number; amount: bigint };

/**
 * What the wallet is short of, computed by the SDK from its own request, the
 * quote it already made, and the balances it read. Never parsed out of the
 * relay's prose.
 *
 * Always in the token the person pays with, on the chain they hold it on. For
 * a registration on Ethereum funded from Celo that is CELO on Celo, and the
 * destination asset is never named: a wallet holding no ETH on Ethereum is
 * what this product is for, not a fault to report.
 *
 * `need` is absent when the SDK cannot state it honestly. The relay's fee is
 * not known until it quotes, so a wallet the relay would not quote for is
 * short without a figure to put on it, and a sentence with no figure beats an
 * invented one. `have` is always known, because the SDK read it.
 */
export type FundingShortfall = {
  /** The token that is missing, the one the payer pays with. */
  token: { symbol: string; decimals: number };
  /** What the operation needs, in `token`, when the SDK can state it. */
  need?: bigint;
  /** What the wallet holds, in `token`, on the chain it pays from. */
  have: bigint;
  /** Where to add funds, and what the relay takes there. */
  fund?: { chain: string; tokens: readonly string[] };
};

/** Everything the map decides from. Only `relayMessage` comes from the relay. */
export type RelayFailureFacts = {
  /** The relay's own message, deepest first, already decoded. */
  relayMessage?: string;
  /** The shortfall the SDK established, when it established one. */
  shortfall?: FundingShortfall;
  /** The chain the operation was on, as a person reads it. */
  chain?: { name: string; chainId: number };
  /**
   * What the person was doing, in their words: "registering this key on
   * Ethereum", "this transfer". Not the SDK's own "prepare the call".
   */
  operation?: string;
  /** The token the fee was to be charged in, for a pricing failure. */
  feeSymbol?: string;
  /** The relay the request went to, for a transport failure. */
  relayUrl?: string;
  /**
   * Set when the relay was asked to source funds for this operation from
   * another chain and refused without saying why.
   *
   * The relay sources the funds before it simulates anything, and when it
   * cannot it logs the shortfall to the wei and then answers the caller with a
   * bare revert: `Could not source the requested funds from any chain` in its
   * own log, `intent reverted: 0x` on the wire (qa, 2026-11-09, section 6e,
   * on the public testnet relay). The SDK is the only place that can turn that
   * back into a sentence, because it knows it asked for funding; a person who
   * cannot read the relay's logs was told the relay gave no reason.
   *
   * The caller sets this only when it has no evidence the payer could have
   * covered the request: a balance that covers the quote the caller already
   * took is evidence the cause is something else, and a wallet holding 133x
   * the fee being told to add funds is the mistake this guards against
   * (`evidence/2026-09-28-s3-registry-write-reverts-0x.md`).
   */
  fundingRefused?: boolean;
  /** Everything the SDK knows, for the debug log. Never shown. */
  detail?: string;
  cause?: unknown;
};

/**
 * A failure with a sentence a person can act on.
 *
 * `message` is that sentence and nothing else, so `String(err)` and an
 * uncaught throw both read correctly. `detail` is the long form.
 */
export class AltanaError extends Error {
  readonly code: AltanaErrorCode;
  /** The next action, on its own, for an app that lays it out separately. */
  readonly action: string;
  /** What happened, on its own, without the action. */
  readonly statement: string;
  /** Everything the SDK knows about the failure. For logs, not for screens. */
  readonly detail?: string;
  /** The relay's own words, kept whether or not the sentence uses them. */
  readonly relayMessage?: string;

  constructor(args: {
    code: AltanaErrorCode;
    statement: string;
    action: string;
    detail?: string;
    relayMessage?: string;
    cause?: unknown;
  }) {
    super(`${args.statement} ${args.action}`.trim(), ...(args.cause !== undefined ? [{ cause: args.cause }] : []));
    this.name = "AltanaError";
    this.code = args.code;
    this.statement = args.statement;
    this.action = args.action;
    if (args.detail !== undefined) this.detail = args.detail;
    if (args.relayMessage !== undefined) this.relayMessage = args.relayMessage;
  }
}

/** True for an error this map produced, across package copies (no `instanceof`). */
export function isAltanaError(err: unknown): err is AltanaError {
  return err instanceof Error && (err as AltanaError).name === "AltanaError" && typeof (err as AltanaError).code === "string";
}

/** The `AltanaError` nearest the surface of an error's cause chain, if any. */
export function altanaErrorOf(err: unknown, limit = 8): AltanaError | undefined {
  let cur: unknown = err;
  for (let i = 0; i < limit && cur !== undefined && cur !== null; i++) {
    if (isAltanaError(cur)) return cur;
    if (typeof cur !== "object") return undefined;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Patterns per code, in the order they are tried. The first match wins. */
const PATTERNS: readonly (readonly [AltanaErrorCode, RegExp])[] = [
  // Transport and configuration first: they explain every later symptom.
  ["chain_not_served", /does not serve chain|no entry for it|Cannot destructure property 'contracts'|unsupported chain|chain not supported/i],
  ["relay_unreachable", /HTTP request failed|fetch failed|Failed to fetch|ECONNREFUSED|ENOTFOUND|socket hang up|network error|timed out|ETIMEDOUT|502 Bad Gateway|503 Service|504 Gateway/i],
  // A wallet this relay never created. Kept with the configuration failures
  // because it explains everything after it: the relay holds the account
  // record a quote is checked against, so a wallet created against another
  // relay (or against one whose record is gone) cannot be acted for here, and
  // every later symptom is downstream of that.
  //
  // The nonce variant is deliberately not matched: `invalid auth item nonce`
  // is the EOA's nonce having moved on, which is a different cause with a
  // different answer.
  ["wallet_unknown_to_relay", /invalid auth(orization)? item, expected|quotes for unknown accounts are not accepted/i],
  // Then the account's own refusals, which a balance never explains away.
  ["quote_expired", /quote (has )?expired|expired quote|quote is no longer valid|QuoteExpired/i],
  ["session_expired", /KeyExpired|key (has )?expired|session (has )?expired|expired key/i],
  ["spend_limit_exceeded", /ExceededSpendLimit|0x9054c912|NoSpendPermissions|0x5ee7e5b1|spend limit|spending limit/i],
  ["call_not_permitted", /Unauthorized(Call|Key)?|not permitted|no call permission|InvalidSignature.*key|KeyDoesNotExist/i],
  ["price_unavailable", /(price|oracle|rate|feed)[^.]{0,40}(unavailable|not available|missing|stale|failed|not found)|(no|without a) (price|rate|oracle)/i],
  // Funding last: everything above can look like a wallet that cannot pay.
  ["insufficient_funds", /insufficient|not enough|deficit|QuoteHasDeficits|InsufficientLiquidity|cannot be funded|unable to fund|no route|exceeds balance|balance too low/i],
];

/** The relay's simulation reverted with no reason bytes ("intent reverted: 0x", or a bare "0x"). */
const NO_REASON = /(^|\s)0x$/;

/**
 * Which failure this is.
 *
 * Pure, and the only place a relay message is read for meaning. A shortfall
 * the SDK established outranks the relay's prose only where the relay said
 * nothing specific: a spend cap or an expired key is the cause even when the
 * wallet also happens to be low, so those patterns are tried first.
 */
export function classifyRelayFailure(facts: RelayFailureFacts): AltanaErrorCode {
  const message = facts.relayMessage ?? "";
  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(message)) return code;
  }
  // A revert with no reason bytes says nothing at all. It is a funding failure
  // only when something else says so, which is what cost qa an hour the other
  // way round (a wallet holding 133x the fee told it could not pay).
  if (facts.shortfall) return "insufficient_funds";
  // The relay refusing to source the funds is itself the cause, and the only
  // one the payer can act on. It reaches the caller as a bare revert, so
  // without this the one failure a cross-asset wallet actually hits reads as
  // "the relay gave no reason".
  if (facts.fundingRefused) return "insufficient_funds";
  return "unknown";
}

/**
 * `16.2`: an amount a person reads, from base units.
 *
 * Six decimals is where a fee stops being informative and starts being a
 * hash. An amount that rounds away to nothing at six keeps its own digits
 * instead, because "you have 0 CELO" is false when the wallet holds dust.
 */
export function readableAmount(amount: bigint, decimals: number): string {
  const exact = formatUnits(amount, decimals);
  const [whole, fraction = ""] = exact.split(".");
  if (fraction.length <= 6) return trimZeros(whole!, fraction);
  const cut = trimZeros(whole!, fraction.slice(0, 6));
  return cut === "0" && amount > 0n ? exact : cut;
}

function trimZeros(whole: string, fraction: string): string {
  const kept = fraction.replace(/0+$/, "");
  return kept.length > 0 ? `${whole}.${kept}` : whole;
}

/** `16.2 CELO`. */
function money(amount: bigint, token: { symbol: string; decimals: number }): string {
  return `${readableAmount(amount, token.decimals)} ${token.symbol}`;
}

/** A list a person reads: `CELO`, `CELO or USDC`, `CELO, USDC or EURm`. */
function orList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** What to add, and where, for a wallet that cannot pay. */
function fundingAction(shortfall: FundingShortfall | undefined): string {
  const fund = shortfall?.fund;
  const tokens = fund?.tokens?.length ? orList(fund.tokens) : shortfall?.token.symbol;
  if (!fund?.chain || !tokens) return "Add funds and try again.";
  return `Add ${tokens} on ${fund.chain}.`;
}

/**
 * The sentence for a wallet that cannot pay, with every figure the SDK has.
 *
 * Only the payer's own token and chain appear. What the operation costs on
 * another chain, and what the wallet does not hold there, are facts for the
 * debug log: a person funding from Celo cannot act on either.
 */
function fundingStatement(facts: RelayFailureFacts): string {
  const short = facts.shortfall;
  const what = facts.operation ?? "this";
  if (short) {
    const have = `you have ${money(short.have, short.token)}`;
    if (short.need !== undefined) {
      return `Not enough ${short.token.symbol} to pay for ${what}: needs about ${money(short.need, short.token)}, ${have}.`;
    }
    return `Not enough ${short.token.symbol} to pay for ${what}: ${have}.`;
  }
  // No figures of our own. The relay quantified it in its own message often
  // enough that its sentence is the better one; ours would drop the numbers.
  // A revert with no reason bytes is not one of those messages: "intent
  // reverted: 0x" is not a sentence and is never put in front of a person.
  const said = NO_REASON.test(facts.relayMessage ?? "") ? undefined : oneLine(facts.relayMessage);
  if (said) return capitalise(said.endsWith(".") ? said : `${said}.`);
  return `There is not enough in this wallet to pay for ${what}.`;
}

/** The relay's message as one line, trimmed, or nothing. */
function oneLine(message: string | undefined): string | undefined {
  const text = message?.split("\n")[0]?.trim();
  return text && text.length > 0 ? text : undefined;
}

function capitalise(text: string): string {
  return /^[a-z]/.test(text) ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/**
 * The failure a person is shown: one sentence, then the next action.
 *
 * Every code has its own wording here, so the sentence for a cause is the same
 * in every app on the SDK. `unknown` is the one case that quotes the relay,
 * which is deliberate: an unrecognised relay message is still a real sentence
 * about the failure, and burying it under "something went wrong" has cost more
 * time than any wording ever saved.
 */
export function explainRelayFailure(facts: RelayFailureFacts): AltanaError {
  const code = classifyRelayFailure(facts);
  const chain = facts.chain?.name;
  const parts = ((): { statement: string; action: string } => {
    switch (code) {
      case "insufficient_funds":
        return { statement: fundingStatement(facts), action: fundingAction(facts.shortfall) };
      case "quote_expired":
        return {
          statement: "The price for this expired before it was sent.",
          action: "Try again, and it will be priced afresh.",
        };
      case "session_expired":
        return { statement: "This session key has expired.", action: "Grant a new session key, then try again." };
      case "spend_limit_exceeded":
        return {
          statement: `This session key's spending limit does not cover this${facts.feeSymbol ? ` in ${facts.feeSymbol}` : ""}.`,
          action: "Grant a new session key with a higher limit, as limits cannot be raised.",
        };
      case "call_not_permitted":
        return {
          statement: "This session key is not allowed to make this call.",
          action: "Grant a new session key that allows it, as permissions cannot be widened.",
        };
      case "relay_unreachable":
        return {
          statement: `Could not reach the Altana relay${facts.relayUrl ? ` at ${facts.relayUrl}` : ""}.`,
          action: "Check the connection and try again.",
        };
      case "chain_not_served":
        return {
          statement: `Altana does not serve ${chain ?? "this chain"} yet.`,
          action: "Switch to a chain it serves, or point the SDK at a relay that serves this one.",
        };
      case "wallet_unknown_to_relay":
        // `invalid authorization item, expected Some(0x0000...0000), got None`
        // is what reached qa for this (evidence/2026-10-20-qa-demo-clickthrough.md),
        // and it says nothing about the wallet or the way out.
        //
        // The wording is Doris's, verbatim and deliberately (2026-11-09, via
        // the PM, after two earlier wordings): the action is the part that
        // matters, and a wallet with no account record behind it is not one a
        // person can get working again. It keeps the relay's own phrase, which
        // is the one thing in this file that does; the rest of the raw text
        // stays in `relayMessage` and `detail`, for the log.
        return {
          statement: "Invalid authorization item.",
          action: "Create a new wallet to continue.",
        };
      case "price_unavailable":
        return {
          statement: `No price was available for ${facts.feeSymbol ?? "the fee token"} just now, so this could not be priced.`,
          action: "Try again in a moment, or pay the fee in another token the relay accepts.",
        };
      default: {
        // A revert with no reason bytes is not a sentence. Quoting "0x" at a
        // person says less than admitting there is nothing to say.
        const said = NO_REASON.test(facts.relayMessage ?? "") ? undefined : oneLine(facts.relayMessage);
        return {
          statement: said
            ? capitalise(said.endsWith(".") ? said : `${said}.`)
            : `This could not be carried out${facts.operation ? ` (${facts.operation})` : ""}, and the relay gave no reason.`,
          action: "Try again; the debug log has the whole failure.",
        };
      }
    }
  })();
  return new AltanaError({
    code,
    ...parts,
    ...(facts.detail !== undefined ? { detail: facts.detail } : {}),
    ...(facts.relayMessage !== undefined ? { relayMessage: facts.relayMessage } : {}),
    ...(facts.cause !== undefined ? { cause: facts.cause } : {}),
  });
}

/**
 * Adds what the SDK was doing to a failure without burying its sentence.
 *
 * A registry write that fails inside a grant used to be re-thrown as "The root
 * registration could not be submitted, so ... <whole message>", which puts the
 * SDK's own bookkeeping in front of the one line a person needs. The context
 * belongs in the log, so that is where it goes; the sentence is untouched.
 */
export function withFailureContext(err: unknown, context: string): Error {
  if (isAltanaError(err)) {
    return new AltanaError({
      code: err.code,
      statement: err.statement,
      action: err.action,
      detail: `${context} ${err.detail ?? err.message}`,
      ...(err.relayMessage !== undefined ? { relayMessage: err.relayMessage } : {}),
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${context} ${message}`, { cause: err });
}
