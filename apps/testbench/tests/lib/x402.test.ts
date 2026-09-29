import { describe, expect, test, vi } from "vitest";
import { probeX402, railNote, readPaidResponse, readSellerHealth } from "../../src/lib/x402";

const USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";

const permit2Req = {
  scheme: "exact",
  network: "eip155:11142220",
  asset: USDC,
  maxAmountRequired: "10000",
  payTo: "0xabc",
  resource: "http://127.0.0.1:4021/paid",
  extra: { assetTransferMethod: "permit2-exact", name: "USDC", version: "2" },
};

const eip3009Req = {
  ...permit2Req,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
};

function jsonResponse(body: unknown, status = 402) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("probeX402", () => {
  test("reads the seller's options and names the one the SDK would pay", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ x402Version: 2, accepts: [eip3009Req, permit2Req] }));
    const probe = await probeX402("http://seller/paid", fetchImpl as never);
    expect(probe.accepts).toHaveLength(2);
    expect(probe.version).toBe(2);
    // Permit2 is preferred, because it is the rail a smart account can pay on.
    expect(probe.chosen?.extra).toMatchObject({ assetTransferMethod: "permit2-exact" });
  });

  test("a route that is not paid is reported as such, not as a payment", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello", { status: 200 }));
    const probe = await probeX402("http://seller/free", fetchImpl as never);
    expect(probe.unexpected).toEqual({ status: 200, body: "hello" });
    expect(probe.accepts).toEqual([]);
    expect(probe.chosen).toBeUndefined();
  });

  test("a bare requirement with no accepts array is still understood", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(permit2Req));
    const probe = await probeX402("http://seller/paid", fetchImpl as never);
    expect(probe.accepts).toHaveLength(1);
  });

  test("options on another chain are not chosen for Celo", async () => {
    const elsewhere = { ...permit2Req, network: "eip155:56" };
    const fetchImpl = vi.fn(async () => jsonResponse({ accepts: [elsewhere] }));
    const probe = await probeX402("http://seller/paid", fetchImpl as never);
    // Payable, but not on Celo; selectX402Requirement still answers, so the
    // panel shows what was chosen rather than pretending there was no option.
    expect(probe.accepts).toHaveLength(1);
  });
});

describe("readPaidResponse", () => {
  test("reads the seller's receipt", async () => {
    const answer = await readPaidResponse(
      jsonResponse(
        {
          data: "the paid answer",
          rail: "permit2-exact",
          settledVia: "merchant key",
          settlement: "confirmed",
          txHash: "0xdeadbeef",
          payer: "0xbuyer",
          amount: "10000",
        },
        200,
      ),
    );
    expect(answer).toMatchObject({
      status: 200,
      rail: "permit2-exact",
      settledVia: "merchant key",
      txHash: "0xdeadbeef",
    });
  });

  test("a seller that is not ours still yields its body rather than nothing", async () => {
    const answer = await readPaidResponse(new Response("not json", { status: 200 }));
    expect(answer).toEqual({ status: 200, raw: "not json" });
  });
});

describe("railNote", () => {
  test("permit2 is named as the smart-account rail, settled locally", () => {
    expect(railNote("permit2-exact")).toContain("ERC-1271");
    expect(railNote("permit2-exact")).toContain("facilitator does not take it");
  });

  test("eip3009 is named as the EOA rail that a smart account cannot use", () => {
    expect(railNote("eip3009")).toContain("ecrecover");
    expect(railNote("eip3009")).toContain("smart account cannot");
  });

  test("an unreported rail is not invented", () => {
    expect(railNote(undefined)).toContain("did not say");
  });
});

describe("readSellerHealth", () => {
  test("reads the seller's own description of itself", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ chainId: 11142220, price: "10000" }, 200));
    expect(await readSellerHealth("http://127.0.0.1:4021/paid", fetchImpl as never)).toMatchObject({
      chainId: 11142220,
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4021/health");
  });

  test("no seller running is undefined, not a thrown error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    expect(await readSellerHealth("http://127.0.0.1:4021/paid", fetchImpl as never)).toBeUndefined();
  });
});
