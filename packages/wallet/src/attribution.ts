/**
 * Attribution tags (ERC-8021): a short list of app codes on the end of a
 * call, so anyone reading the chain can tell which app sent a transaction.
 *
 * The tag is `codes | length | schema | marker`: the codes as ASCII, comma
 * separated, one length byte, schema `0x00`, and a fixed 16-byte marker. A
 * contract never reads past its own arguments, so the bytes change nothing
 * about what the call does.
 *
 * `altana` is always the first code. An app adds its own after it with
 * `createClient({ appCode })`.
 *
 * Pure: nothing here touches the network.
 */
import { Attribution } from "ox/erc8021";
import { concat, type Address, type Hex } from "viem";
import type { Call } from "./internal/relay.js";

/** The code every transaction sent through the SDK carries. */
export const ALTANA_CODE = "altana";

/** The 16 bytes every ERC-8021 tag ends with. */
export const ERC_8021_MARKER: Hex = "0x80218021802180218021802180218021";

/**
 * Relay.link's contracts: its router, its approval proxy and its deposit
 * contract, at the same address on every chain Altana serves. A call to one
 * of them is never tagged. Relay.link writes its own request id as the last
 * 32 bytes of a swap call and finds the transaction by it, so those bytes
 * have to stay where they are.
 */
export const UNTAGGED_TARGETS: readonly Address[] = [
  "0x0729E2a4716d9f7dD17858d5d504426D228697f7",
  "0x5567954cD026CEbFE486062cb75848e0f1c12E58",
  "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
];

/** What `createClient` accepts for attribution. */
export type AttributionOptions = {
  /**
   * Your app's code, or several. Lowercase letters, digits and underscores,
   * up to 32 characters each. Sent after `altana` on every transaction.
   */
  appCode?: string | readonly string[];
  /** `false` sends transactions with no tag at all. On by default. */
  attribution?: false;
};

const CODE = /^[a-z0-9_]{1,32}$/;

/**
 * The codes a client sends, `altana` first, each once. Throws on a code that
 * is not lowercase letters, digits and underscores, 1 to 32 characters.
 */
export function attributionCodes(appCode?: string | readonly string[]): string[] {
  const own = appCode === undefined ? [] : typeof appCode === "string" ? [appCode] : [...appCode];
  for (const code of own) {
    if (typeof code !== "string" || !CODE.test(code)) {
      throw new Error(
        `createClient: the app code ${JSON.stringify(code)} cannot be used. ` +
          `Use lowercase letters, digits and underscores, up to 32 characters (for example "my_app").`,
      );
    }
  }
  return [...new Set([ALTANA_CODE, ...own])];
}

/** The tag for a list of codes, as the bytes that go on the end of a call. */
export function attributionTag(codes: readonly string[]): Hex {
  if (codes.length === 0) throw new Error("attributionTag: at least one code is required.");
  const tag = Attribution.toDataSuffix({ codes: [...codes] });
  // One length byte covers the whole comma-separated list.
  if (codes.join(",").length > 255) {
    throw new Error("createClient: the app codes are too long together. Keep the list under 255 characters.");
  }
  return tag;
}

/**
 * The tag a client sends, from its options: undefined when attribution is
 * off, otherwise the tag for `altana` plus the app's own codes.
 */
export function clientAttributionTag(opts: AttributionOptions): Hex | undefined {
  // The codes are checked even when attribution is off, so a typo does not
  // wait for the day it is switched on.
  const codes = attributionCodes(opts.appCode);
  return opts.attribution === false ? undefined : attributionTag(codes);
}

const hasData = (call: Call): boolean => call.data !== undefined && call.data !== "0x";
const untagged = (call: Call): boolean => UNTAGGED_TARGETS.some((t) => t.toLowerCase() === call.to.toLowerCase());

/**
 * The same calls with the tag on the end of one of them. Every other call is
 * returned as it came, and the input is never changed.
 *
 *   - The tag goes on the last call that has data and is not a Relay.link
 *     call (`UNTAGGED_TARGETS`).
 *   - When no call has data (plain coin sends only), a wallet key puts the tag
 *     on the last one as its data. A session key sends them as they are.
 *   - When neither applies, nothing is tagged.
 */
export function tagCalls(calls: readonly Call[], tag: Hex, opts: { session: boolean }): readonly Call[] {
  let index = -1;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (hasData(calls[i]!) && !untagged(calls[i]!)) {
      index = i;
      break;
    }
  }
  if (index === -1 && !opts.session && calls.length > 0 && !calls.some(hasData)) {
    const last = calls.length - 1;
    if (!untagged(calls[last]!)) index = last;
  }
  if (index === -1) return calls;
  return calls.map((call, i) => (i === index ? { ...call, data: concat([call.data ?? "0x", tag]) } : call));
}

/** The codes read back from a tag. */
export type ParsedAttribution = { codes: string[] };

/**
 * Reads the tag from a call's data, or from a whole transaction's input.
 *
 * A call's data ends with the tag. Inside a relayed transaction the call is
 * wrapped and padded, so the tag sits in the middle of the input: the last
 * marker in the bytes is found and the tag read back from there. Undefined
 * when there is no tag.
 */
export function parseAttribution(data: Hex): ParsedAttribution | undefined {
  const hex = data.toLowerCase();
  const marker = ERC_8021_MARKER.slice(2);
  const at = hex.lastIndexOf(marker);
  if (at < 2 || (at - 2) % 2 !== 0) return undefined;
  try {
    const parsed = Attribution.fromData(`0x${hex.slice(2, at + marker.length)}` as Hex);
    const codes = parsed && "codes" in parsed ? parsed.codes : undefined;
    if (!codes || codes.length === 0) return undefined;
    return { codes: [...codes] };
  } catch {
    return undefined;
  }
}
