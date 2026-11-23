/**
 * The attribution tag (ERC-8021): its exact bytes, which codes are accepted,
 * which call it lands on, and that every other call is left alone.
 */
import { describe, expect, test } from "bun:test";
import { concat, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import {
  ALTANA_CODE,
  ERC_8021_MARKER,
  UNTAGGED_TARGETS,
  attributionCodes,
  attributionTag,
  clientAttributionTag,
  parseAttribution,
  tagCalls,
} from "./attribution.js";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const FRIEND = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = UNTAGGED_TARGETS[0]!;
const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [FRIEND, 1_000n] });
const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, 1_000n] });
/** A swap call the way Relay.link builds one: its request id is the last 32 bytes. */
const REQUEST_ID = `0x${"7e".repeat(32)}` as Hex;
const swap = concat(["0xcd6e13f7", `0x${"00".repeat(96)}`, REQUEST_ID]);

const TAG = attributionTag(["altana", "my_app"]);

describe("the tag's bytes", () => {
  test("match the ERC-8021 test vector", () => {
    // 0xdddddddd + "baseapp": codes, length 7, schema 0, marker.
    expect(concat(["0xdddddddd", attributionTag(["baseapp"])])).toBe(
      "0xdddddddd62617365617070070080218021802180218021802180218021",
    );
  });

  test("match the tag proven on BNB testnet and Celo Sepolia", () => {
    expect(attributionTag(["altana", "altana_test"])).toBe(
      "0x616c74616e612c616c74616e615f74657374120080218021802180218021802180218021",
    );
  });

  test("end with the marker", () => {
    expect(TAG.endsWith(ERC_8021_MARKER.slice(2))).toBe(true);
  });
});

describe("codes", () => {
  test("altana is always first, and each code appears once", () => {
    expect(attributionCodes()).toEqual([ALTANA_CODE]);
    expect(attributionCodes("my_app")).toEqual(["altana", "my_app"]);
    expect(attributionCodes(["my_app", "celo_b7k3p9da"])).toEqual(["altana", "my_app", "celo_b7k3p9da"]);
    expect(attributionCodes(["altana", "my_app", "my_app"])).toEqual(["altana", "my_app"]);
  });

  test.each(["My_App", "my app", "my,app", "my-app", "", "a".repeat(33)])("refuses %p in plain words", (code) => {
    expect(() => attributionCodes(code)).toThrow(/lowercase letters, digits and underscores/);
  });

  test("a client sends altana alone, its own code after it, or nothing", () => {
    expect(parseAttribution(clientAttributionTag({})!)).toEqual({ codes: ["altana"] });
    expect(parseAttribution(clientAttributionTag({ appCode: "my_app" })!)).toEqual({ codes: ["altana", "my_app"] });
    expect(clientAttributionTag({ attribution: false })).toBeUndefined();
    expect(clientAttributionTag({ appCode: "my_app", attribution: false })).toBeUndefined();
  });

  test("a bad code is refused even with attribution off", () => {
    expect(() => clientAttributionTag({ appCode: "My App", attribution: false })).toThrow();
  });
});

describe("which call gets the tag", () => {
  test("a single call with data", () => {
    const out = tagCalls([{ to: TOKEN, data: transfer }], TAG, { session: false });
    expect(out).toEqual([{ to: TOKEN, data: concat([transfer, TAG]) }]);
  });

  test("the last call with data, and the others are the very same objects", () => {
    const calls = [
      { to: TOKEN, data: approve },
      { to: TOKEN, data: transfer },
      { to: FRIEND, value: 1n },
    ];
    const out = tagCalls(calls, TAG, { session: false });
    expect(out[0]).toBe(calls[0]!);
    expect(out[1]).toEqual({ to: TOKEN, data: concat([transfer, TAG]) });
    expect(out[2]).toBe(calls[2]!);
  });

  test("the input is not changed", () => {
    const calls = [{ to: TOKEN, data: transfer }];
    tagCalls(calls, TAG, { session: true });
    expect(calls).toEqual([{ to: TOKEN, data: transfer }]);
  });

  test("the selector at the start of the call does not move", () => {
    const [out] = tagCalls([{ to: TOKEN, data: transfer }], TAG, { session: true });
    expect(out!.data!.slice(0, 10)).toBe(transfer.slice(0, 10));
  });

  test("a session key's call with data is tagged like a wallet key's", () => {
    const out = tagCalls([{ to: TOKEN, data: transfer }], TAG, { session: true });
    expect(parseAttribution(out[0]!.data!)).toEqual({ codes: ["altana", "my_app"] });
  });
});

describe("Relay.link calls are never tagged", () => {
  test.each(UNTAGGED_TARGETS.map((t) => [t]))("a call to %s keeps its bytes", (target) => {
    const calls = [{ to: target, data: swap, value: 5n }];
    expect(tagCalls(calls, TAG, { session: false })).toBe(calls);
  });

  test("the address is matched whatever its casing", () => {
    const calls = [{ to: ROUTER.toLowerCase() as Address, data: swap }];
    expect(tagCalls(calls, TAG, { session: false })).toBe(calls);
  });

  test("approve then swap: the tag goes on the approval, and the request id stays the last 32 bytes of the swap", () => {
    const calls = [
      { to: TOKEN, data: approve },
      { to: ROUTER, data: swap },
    ];
    const out = tagCalls(calls, TAG, { session: false });
    expect(out[0]).toEqual({ to: TOKEN, data: concat([approve, TAG]) });
    expect(out[1]).toBe(calls[1]!);
    expect(out[1]!.data!.endsWith(REQUEST_ID.slice(2))).toBe(true);
  });

  test("a coin send beside a swap is not given the tag as its data", () => {
    const calls = [
      { to: FRIEND, value: 1n },
      { to: ROUTER, data: swap },
    ];
    expect(tagCalls(calls, TAG, { session: false })).toBe(calls);
  });
});

describe("plain coin sends", () => {
  test("a wallet key puts the tag on the last one as its only data", () => {
    const calls = [
      { to: FRIEND, value: 1n },
      { to: FRIEND, value: 2n, data: "0x" as Hex },
    ];
    const out = tagCalls(calls, TAG, { session: false });
    expect(out[0]).toBe(calls[0]!);
    expect(out[1]).toEqual({ to: FRIEND, value: 2n, data: TAG });
  });

  test("a session key sends them exactly as they are", () => {
    const calls = [{ to: FRIEND, value: 1n }];
    expect(tagCalls(calls, TAG, { session: true })).toBe(calls);
  });

  test("no calls, no tag", () => {
    const calls: { to: Address }[] = [];
    expect(tagCalls(calls, TAG, { session: false })).toBe(calls);
  });
});

describe("reading a tag back", () => {
  test("from a call's data", () => {
    expect(parseAttribution(concat([transfer, TAG]))).toEqual({ codes: ["altana", "my_app"] });
  });

  test("from the middle of a transaction's input, where the call is wrapped and padded", () => {
    const input = concat(["0xdeadbeef", `0x${"11".repeat(64)}`, transfer, TAG, `0x${"00".repeat(27)}`, `0x${"22".repeat(320)}`]);
    expect(parseAttribution(input)).toEqual({ codes: ["altana", "my_app"] });
  });

  test("nothing when there is no tag", () => {
    expect(parseAttribution(transfer)).toBeUndefined();
    expect(parseAttribution("0x")).toBeUndefined();
    expect(parseAttribution(ERC_8021_MARKER)).toBeUndefined();
  });
});
