import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import {
  probeRelay,
  selectionMatches,
  servedAndKnown,
  servedButUnknown,
} from "../../src/lib/relayCapabilities";

const KNOWN = [CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId, SEPOLIA.chainId];

function rpc(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("probeRelay", () => {
  test("asks with no chain filter, because a filter of none answers none", async () => {
    // The live relay answers every served chain for `params: []`, and nothing
    // at all for `params: [[]]`, which is a filter for no chains.
    const fetchImpl = rpc({ result: { "0xaa044c": {}, "0xaa36a7": {} } });
    await probeRelay("http://relay", fetchImpl as never);
    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent).toMatchObject({ method: "wallet_getCapabilities", params: [] });
  });

  test("reads hex chain keys, as the relay sends them", async () => {
    const probe = await probeRelay("http://relay", rpc({ result: { "0xaa044c": {}, "0xaa36a7": {} } }) as never);
    expect(probe).toEqual({ status: "serving", chainIds: [CELO_SEPOLIA.chainId, SEPOLIA.chainId] });
  });

  test("decimal keys are read too", async () => {
    const probe = await probeRelay("http://relay", rpc({ result: { "11142220": {} } }) as never);
    expect(probe).toEqual({ status: "serving", chainIds: [CELO_SEPOLIA.chainId] });
  });

  test("a relay that is not there is unreachable, not a thrown error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    expect(await probeRelay("http://nope", fetchImpl as never)).toEqual({
      status: "unreachable",
      reason: "fetch failed",
    });
  });

  test("an HTTP error and a JSON-RPC error are both unreachable, with the reason", async () => {
    expect(await probeRelay("http://relay", rpc({}, 502) as never)).toMatchObject({
      status: "unreachable",
      reason: "the relay answered 502",
    });
    expect(
      await probeRelay("http://relay", rpc({ error: { message: "method not found" } }) as never),
    ).toMatchObject({ status: "unreachable", reason: "method not found" });
  });

  test("a result that is not an object is refused rather than read as no chains", async () => {
    expect(await probeRelay("http://relay", rpc({ result: null }) as never)).toMatchObject({
      status: "unreachable",
    });
  });

  test("a relay that never answers gives up and says so", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const probe = await probeRelay("http://slow", fetchImpl as never, 10);
    expect(probe).toEqual({ status: "unreachable", reason: "no answer within 0 seconds" });
  });
});

describe("servedAndKnown", () => {
  test("only chains the relay serves and the bench can configure", () => {
    const probe = { status: "serving" as const, chainIds: [CELO_SEPOLIA.chainId, 97] };
    expect(servedAndKnown(probe, KNOWN)).toEqual([CELO_SEPOLIA.chainId]);
    expect(servedButUnknown(probe, KNOWN)).toEqual([97]);
  });

  test("an unreachable relay offers nothing rather than guessing", () => {
    expect(servedAndKnown({ status: "unreachable", reason: "x" }, KNOWN)).toEqual([]);
    expect(servedButUnknown({ status: "unreachable", reason: "x" }, KNOWN)).toEqual([]);
  });
});

describe("selectionMatches", () => {
  test("order does not matter", () => {
    expect(selectionMatches([SEPOLIA.chainId, CELO_SEPOLIA.chainId], [CELO_SEPOLIA.chainId, SEPOLIA.chainId])).toBe(true);
  });

  test("a missing or extra chain is a mismatch", () => {
    expect(selectionMatches([CELO_SEPOLIA.chainId], [CELO_SEPOLIA.chainId, SEPOLIA.chainId])).toBe(false);
    expect(selectionMatches([CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId], [CELO_SEPOLIA.chainId])).toBe(false);
  });

  test("nothing served is not a mismatch: there is nothing to disagree with", () => {
    expect(selectionMatches([CELO_SEPOLIA.chainId], [])).toBe(true);
  });
});
