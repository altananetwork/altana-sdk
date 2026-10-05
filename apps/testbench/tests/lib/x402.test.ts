import { describe, expect, test, vi } from "vitest";
import {
  amountOf,
  explainX402Failure,
  probeX402,
  railNote,
  railOf,
  readPaidResponse,
  readSellerHealth,
} from "../../src/lib/x402";

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
  test("each rail names the contract that verifies the signature, which is what needs approving", () => {
    // The old copy said Permit2 was the only rail a smart account could pay on
    // and that Celo's USDC was ecrecover only. Both were wrong, and came from
    // our own missing approval (evidence/2026-10-05-celo-usdc-does-honour-erc1271.md).
    expect(railNote("permit2-exact")).toContain("Permit2 is the contract that verifies");
    expect(railNote("eip3009")).toContain("the token is the contract that verifies");
    for (const rail of ["permit2-exact", "eip3009"]) {
      expect(railNote(rail), rail).toContain("approved checker for the key");
    }
  });

  test("neither rail is described as closed to a smart account any more", () => {
    for (const rail of ["permit2-exact", "eip3009"]) {
      expect(railNote(rail)).not.toMatch(/cannot pay|ecrecover only|EOA buyers/);
    }
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

describe("amountOf and railOf", () => {
  test("reads the real B402 amount field, not only the legacy one", () => {
    // Our own seller sends `amount`; reading only `maxAmountRequired` left the
    // amount column blank against it.
    expect(amountOf({ ...permit2Req, amount: "10000", maxAmountRequired: undefined } as never)).toBe("10000");
    expect(amountOf({ ...permit2Req, maxAmountRequired: "9999", amount: undefined } as never)).toBe("9999");
    expect(amountOf({ ...permit2Req, amount: undefined, maxAmountRequired: undefined } as never)).toBeUndefined();
  });

  test("the rail comes from the requirement's own extra, or is unstated", () => {
    expect(railOf(permit2Req as never)).toBe("permit2-exact");
    expect(railOf(eip3009Req as never)).toBe("eip3009");
    expect(railOf({ ...permit2Req, extra: undefined } as never)).toBeUndefined();
  });
});

describe("explainX402Failure", () => {
  const REVERT = "unexpected_error: execution reverted: FiatTokenV2: invalid signature";

  test("the unmapped 500 becomes the sentence someone needs at that moment", () => {
    // Celo's facilitator defers to the chain, so a refused signature arrives as
    // an unmapped execution-reverted rather than a structured invalid_signature
    // (evidence/2026-10-05-celo-facilitator-permit2.md).
    const said = explainX402Failure(REVERT);
    expect(said).toContain("FiatTokenV2: invalid signature");
    expect(said).toContain("not an approved signature checker");
    expect(said).toContain("x402 tokens ticked");
  });

  test("it says whose answer the revert is, so the facilitator is not blamed for it", () => {
    expect(explainX402Failure(REVERT)).toContain("the chain's answer relayed, not a failure of the facilitator");
  });

  test("a balance failure is told apart from a signature one, and says which runs first", () => {
    const said = explainX402Failure("insufficient_funds: Onchain balance is not enough");
    expect(said).toContain("does not hold enough");
    expect(said).toContain("before the signature one");
    // Not a chain revert, so it does not claim to be one.
    expect(said).not.toContain("relayed");
  });

  test("the settle key and the envelope shape each get their own words", () => {
    expect(explainX402Failure("unauthorized: Missing X-API-Key")).toContain("issued at x402.celo.org");
    expect(explainX402Failure("invalid_format: data did not match any variant")).toContain("x402 version");
  });

  test("anything it does not recognise is left exactly as it was", () => {
    expect(explainX402Failure("some new failure")).toBe("some new failure");
  });
});
