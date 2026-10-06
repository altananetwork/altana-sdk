/**
 * The EIP-7708 asset-diff sanitiser.
 *
 * Fixtures are the captured post-Glamsterdam shape, not an invention: an
 * `0xff..fe` entry with `type: "erc20"` and no `symbol`, sitting beside the
 * native entry it duplicates. Porto's `AssetDiffAsset` union requires
 * `symbol: string` in every variant, so that entry is what makes porto reject
 * the whole response.
 */
import { describe, expect, test } from "bun:test";
import { EIP7708_SYSTEM_ADDRESS, stripEip7708AssetDiffs } from "./eip7708.js";
import { buildRelayClient } from "./relay.js";
import { SEPOLIA } from "../config.js";
import captured from "./fixtures/sepolia-prepare-calls-eip7708.json" with { type: "json" };
import clean from "./fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const CHAIN = "0xaa36a7";
const diffsOf = (r: any, chain = CHAIN) => r.capabilities.assetDiffs[chain];

describe("stripEip7708AssetDiffs", () => {
  test("drops the system-address entry and keeps the native one it duplicates", () => {
    const out = stripEip7708AssetDiffs(structuredClone(captured) as any);
    const [, diffs] = diffsOf(out)[0];
    expect(diffs).toHaveLength(1);
    expect(diffs[0].symbol).toBe("ETH");
    expect(diffs[0].type).toBeNull();
    // The value the native entry carries is untouched: dropping, not merging.
    expect(diffs[0].value).toBe("0x1");
  });

  test("drops an account whose only diff was the system address, rather than leaving it empty", () => {
    const out = stripEip7708AssetDiffs(structuredClone(captured) as any);
    expect(diffsOf(captured as any)).toHaveLength(2);
    expect(diffsOf(out)).toHaveLength(1);
    expect(diffsOf(out)[0][0]).toBe("0xb248602eaadd9c3e2db4575c4e4d58003b7a2740");
  });

  test("no system address survives anywhere in the result", () => {
    const out = stripEip7708AssetDiffs(structuredClone(captured) as any);
    expect(JSON.stringify(out).toLowerCase()).not.toContain(EIP7708_SYSTEM_ADDRESS);
  });

  test("matches the address case-insensitively", () => {
    const mixed = structuredClone(captured) as any;
    diffsOf(mixed)[0][1][1].address = "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfE";
    const out = stripEip7708AssetDiffs(mixed);
    expect(diffsOf(out)[0][1]).toHaveLength(1);
  });

  test("a response with no 7708 entry is returned unchanged, by identity", () => {
    const out = stripEip7708AssetDiffs(clean as any);
    // Returned as-is rather than rebuilt, so an untouched response costs nothing.
    expect(out).toBe(clean as any);
  });

  test("covers wallet_getCallsHistory, where assetDiffs sits under each array entry", () => {
    // The second method carrying assetDiffs: result[i].capabilities.assetDiffs.
    const history = [structuredClone(captured) as any, structuredClone(captured) as any];
    const out = stripEip7708AssetDiffs(history);
    for (const entry of out) {
      expect(diffsOf(entry)).toHaveLength(1);
      expect(diffsOf(entry)[0][1]).toHaveLength(1);
    }
  });

  test("leaves every other field alone", () => {
    const out = stripEip7708AssetDiffs(structuredClone(captured) as any) as any;
    expect(out.comment).toBe((captured as any).comment);
    expect(Object.keys(out.capabilities)).toEqual(["assetDiffs"]);
  });

  test("tolerates the shapes a relay could still send", () => {
    // Nothing here should throw: the sanitiser is on every relay response.
    expect(stripEip7708AssetDiffs(null)).toBeNull();
    expect(stripEip7708AssetDiffs("0x1")).toBe("0x1");
    expect(stripEip7708AssetDiffs({ capabilities: {} })).toEqual({ capabilities: {} });
    expect(stripEip7708AssetDiffs({ capabilities: { assetDiffs: {} } })).toEqual({
      capabilities: { assetDiffs: {} },
    });
    // An entry that is not a [address, diffs] tuple is passed through untouched.
    const odd = { capabilities: { assetDiffs: { [CHAIN]: ["unexpected"] } } };
    expect(stripEip7708AssetDiffs(odd)).toEqual(odd);
  });

  test("an empty chain key survives as an empty list, which the schema allows", () => {
    const only7708 = {
      capabilities: {
        assetDiffs: {
          [CHAIN]: [["0x0000000000000000000000000000000000000001", [{ address: EIP7708_SYSTEM_ADDRESS, type: "erc20", value: "0x1" }]]],
        },
      },
    };
    const out = stripEip7708AssetDiffs(only7708) as any;
    expect(out.capabilities.assetDiffs[CHAIN]).toEqual([]);
  });
});

/**
 * The wiring, not just the function: `buildRelayClient` is the single transport
 * the SDK hands to porto, so the sanitiser has to be in it. Mocked at `fetch`,
 * which is how the other relay tests in this package drive the wire.
 */
describe("buildRelayClient's transport", () => {
  test("sanitises a wallet_prepareCalls response before it reaches a caller", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (_url: any, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const reqs = Array.isArray(body) ? body : [body];
        const answers = reqs.map((r: { id: number }) => ({
          id: r.id,
          jsonrpc: "2.0",
          result: structuredClone(captured),
        }));
        return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const client = buildRelayClient(SEPOLIA);
      const result: any = await client.request({ method: "wallet_prepareCalls" as any, params: [] as any });

      // What the relay sent had two accounts and a 7708 entry; what the caller
      // sees has neither.
      expect(diffsOf(captured as any)).toHaveLength(2);
      expect(diffsOf(result)).toHaveLength(1);
      expect(diffsOf(result)[0][1]).toHaveLength(1);
      expect(JSON.stringify(result).toLowerCase()).not.toContain(EIP7708_SYSTEM_ADDRESS);
    } finally {
      globalThis.fetch = original;
    }
  });
});
