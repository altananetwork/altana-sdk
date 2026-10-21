import { test, expect, afterEach, mock, spyOn } from "bun:test";
import type { Address } from "viem";
import * as SignOrder from "./signOrder.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import type { Session } from "./internal/sessions.js";
import { fetchWithX402, type X402Requirement } from "./x402.js";

/**
 * These tests count fetch calls by index to assert the payment wire, so the two
 * on-chain approval reads `fetchWithX402` now makes by default would shift every
 * index. The approval guard has its own tests in x402Approvals.test.ts.
 */
const NO_APPROVAL_CHECK = { checkApprovals: false } as const;

const WALLET: Address = "0x1111111111111111111111111111111111111111";
const TOKEN: Address = "0x55d398326f99059fF775485246999027B3197955";
const PAYTO: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPENDER: Address = "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

function makeSession(signer: Signer): Session {
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: {},
    expiry: 0,
  };
}

test("fetchWithX402 pays a 402 and retries with an X-PAYMENT header", async () => {
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "bsc",
              asset: TOKEN,
              maxAmountRequired: "10000",
              payTo: PAYTO,
              maxTimeoutSeconds: 600,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://api.example.com/resource", undefined, NO_APPROVAL_CHECK);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("paid-content");

  expect(calls.length).toBe(2);
  const retryHeaders = new Headers(calls[1]!.init!.headers);
  const xPayment = retryHeaders.get("X-PAYMENT");
  expect(xPayment).toBeTruthy();
  const decoded = JSON.parse(Buffer.from(xPayment!, "base64").toString("utf8"));
  expect(decoded.scheme).toBe("exact");
  expect(decoded.payload.authorization.from.toLowerCase()).toBe(
    WALLET.toLowerCase(),
  );
});

test("fetchWithX402 picks BNB permit2-exact from a real multi-option B402 402", async () => {
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  // Real B402 shape: many `accepts`, all scheme "exact"; the rail is in
  // extra.assetTransferMethod. Base-USDC/eip3009 is listed FIRST, but a smart
  // wallet on BNB (56) should pay via the BNB permit2-exact USDT option.
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              payTo: PAYTO,
              maxTimeoutSeconds: 30,
              extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
              amount: "10000",
            },
            {
              scheme: "exact",
              network: "eip155:56",
              asset: TOKEN,
              payTo: PAYTO,
              maxTimeoutSeconds: 30,
              extra: {
                name: "Tether USD",
                version: "1",
                assetTransferMethod: "permit2-exact",
                spenderAddress: "0x3038f7ac3b4D1a3fe886BdCB5cD01e9f6BDd8633",
              },
              amount: "10000000000000000",
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://pro-api.example.com/x402", undefined, {
    ...NO_APPROVAL_CHECK,
    chainId: 56,
  });
  expect(res.status).toBe(200);

  const retryHeaders = new Headers(calls[1]!.init!.headers);
  const decoded = JSON.parse(
    Buffer.from(retryHeaders.get("X-PAYMENT")!, "base64").toString("utf8"),
  );
  expect(decoded.x402Version).toBe(2);
  expect(decoded.network).toBe("eip155:56");
  // Chose the permit2 rail (has a `permit`, not an eip3009 `authorization`).
  expect(decoded.payload.permit).toBeDefined();
  expect(decoded.payload.permit.permitted.token.toLowerCase()).toBe(TOKEN.toLowerCase());
});

test("fetchWithX402 passes non-402 responses through untouched", async () => {
  const session = makeSession(createPrivateKeySigner());
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://api.example.com/free", undefined, NO_APPROVAL_CHECK);
  expect(res.status).toBe(200);
  expect(count).toBe(1); // no retry
});

test("fetchWithX402 sends the envelope under both X-PAYMENT and PAYMENT-SIGNATURE", async () => {
  // Some b402 merchants (CoinMarketCap among them) read PAYMENT-SIGNATURE and
  // ignore X-PAYMENT; Binance's own Studio buyer sends both.
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          resource: {
            url: "https://api.example.com/resource",
            mimeType: "application/json",
          },
          accepts: [
            {
              scheme: "exact",
              network: "eip155:56",
              asset: TOKEN,
              amount: "10000",
              payTo: PAYTO,
              maxTimeoutSeconds: 600,
              extra: {
                name: "Tether USD",
                version: "1",
                assetTransferMethod: "permit2-exact",
                spenderAddress: SPENDER,
              },
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  const res = await fetchWithX402(session, "https://api.example.com/resource", undefined, NO_APPROVAL_CHECK);
  expect(res.status).toBe(200);

  const retryHeaders = new Headers(calls[1]!.init!.headers);
  const xPayment = retryHeaders.get("X-PAYMENT");
  const paymentSignature = retryHeaders.get("PAYMENT-SIGNATURE");
  expect(xPayment).toBeTruthy();
  // Byte-identical: the same envelope under both names, never two signatures.
  expect(paymentSignature).toBe(xPayment);

  const decoded = JSON.parse(Buffer.from(xPayment!, "base64").toString("utf8"));
  expect(decoded.resource).toEqual({
    url: "https://api.example.com/resource",
    mimeType: "application/json",
  });
  expect(decoded.payload.permit2Authorization).toBeDefined();
});

test("fetchWithX402 falls back to the requested URL when the 402 quotes no resource", async () => {
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:56",
              asset: TOKEN,
              amount: "10000",
              payTo: PAYTO,
              maxTimeoutSeconds: 600,
              extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  await fetchWithX402(session, "https://api.example.com/resource", undefined, NO_APPROVAL_CHECK);

  const header = new Headers(calls[1]!.init!.headers).get("X-PAYMENT")!;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  expect(decoded.resource).toEqual({ url: "https://api.example.com/resource" });
});

test("fetchWithX402 normalizes a bare-string resource from the challenge", async () => {
  const session = makeSession(createPrivateKeySigner());
  const calls: { url: string; init?: RequestInit }[] = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          x402Version: 2,
          // Our own x402-server historically emitted a bare URL string here.
          resource: "https://merchant.example/premium",
          accepts: [
            {
              scheme: "exact",
              network: "eip155:56",
              asset: TOKEN,
              amount: "10000",
              payTo: PAYTO,
              maxTimeoutSeconds: 600,
              extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
            },
          ],
        }),
        { status: 402 },
      );
    }
    return new Response("paid-content", { status: 200 });
  }) as typeof fetch;

  await fetchWithX402(session, "https://api.example.com/resource", undefined, NO_APPROVAL_CHECK);

  const header = new Headers(calls[1]!.init!.headers).get("X-PAYMENT")!;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  expect(decoded.resource).toEqual({ url: "https://merchant.example/premium" });
});

const RESOURCE_URL = "https://api.example.com/resource";
const V2_REQUIREMENT = {
  scheme: "exact", network: "eip155:56", asset: TOKEN, amount: "10000",
  payTo: PAYTO, maxTimeoutSeconds: 600,
  extra: { name: "USD Coin", version: "2" },
};
const V2_CHALLENGE = {
  x402Version: 2,
  resource: { url: RESOURCE_URL, description: "Paid resource", mimeType: "application/json" },
  accepts: [V2_REQUIREMENT],
};
const encodeChallenge = (challenge: unknown) => Buffer.from(JSON.stringify(challenge)).toString("base64");

function mockChallenge(response: Response, retry = new Response("paid-content")) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) !== RESOURCE_URL || calls.length > 2) throw new Error("unexpected fetch");
    return calls.length === 1 ? response : retry;
  }) as typeof fetch;
  // Spy on the actual typed-data signing boundary, not signer.signDigest:
  // private-key sessions sign through Porto and never call that method.
  const sign = spyOn(SignOrder, "signOrderTypedData").mockResolvedValue("0x1234");
  return { calls, sign, retry };
}

function retryPayment(calls: { init?: RequestInit }[]) {
  const headers = new Headers(calls[1]!.init?.headers);
  expect(headers.get("PAYMENT-SIGNATURE")).toBe(headers.get("X-PAYMENT"));
  return JSON.parse(Buffer.from(headers.get("PAYMENT-SIGNATURE")!, "base64").toString("utf8"));
}

for (const body of [null, "", "{}", "Payment required", "{"]) {
  test(`fetchWithX402 reads a canonical v2 header without parsing body ${JSON.stringify(body)}`, async () => {
    const response = new Response(body, { status: 402, headers: {
      "payment-required": encodeChallenge(V2_CHALLENGE),
    } });
    const { calls, sign, retry } = mockChallenge(response);
    const result = await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
    expect(result).toBe(retry);
    expect(response.bodyUsed).toBe(false);
    expect(calls).toHaveLength(2);
    expect(sign).toHaveBeenCalledTimes(1);
    const payment = retryPayment(calls);
    expect(payment.x402Version).toBe(2);
    expect(payment.resource).toEqual(V2_CHALLENGE.resource);
    expect(payment.accepted).toEqual(V2_REQUIREMENT);
    expect(payment.payload.authorization.to).toBe(PAYTO);
    expect(payment.payload.authorization.value).toBe("10000");
  });
}

test("fetchWithX402 takes the complete header challenge over a conflicting legacy body", async () => {
  const response = new Response(JSON.stringify({
    x402Version: 1, resource: { url: "https://body.example/other" },
    accepts: [{ ...V2_REQUIREMENT, amount: "90000", payTo: WALLET }],
  }), { status: 402, headers: { "PAYMENT-REQUIRED": encodeChallenge(V2_CHALLENGE) } });
  const { calls, sign } = mockChallenge(response);
  await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
  const payment = retryPayment(calls);
  expect(response.bodyUsed).toBe(false);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(2);
  expect(payment.x402Version).toBe(2);
  expect(payment.resource).toEqual(V2_CHALLENGE.resource);
  expect(payment.accepted).toEqual(V2_REQUIREMENT);
  expect(payment.payload.authorization.to).toBe(PAYTO);
  expect(payment.payload.authorization.value).toBe("10000");
});

test("fetchWithX402 reads unpadded base64 and selects the requested B402 chain from the header", async () => {
  const b402 = { ...V2_REQUIREMENT, extra: {
    assetTransferMethod: "permit2-exact", spenderAddress: SPENDER,
  } };
  const challenge = { ...V2_CHALLENGE, accepts: [{ ...b402, network: "eip155:8453" }, b402] };
  const { calls, sign } = mockChallenge(new Response(null, { status: 402, headers: {
    "PAYMENT-REQUIRED": encodeChallenge(challenge).replace(/=+$/, ""),
  } }));
  await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, {
    ...NO_APPROVAL_CHECK, chainId: 56,
  });
  const payment = retryPayment(calls);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(payment.accepted).toEqual(b402);
  expect(payment.resource).toEqual(V2_CHALLENGE.resource);
  expect(payment.payload.permit.witness.to).toBe(PAYTO);
  expect(payment.payload.permit.permitted.amount).toBe("10000");
});

test("fetchWithX402 cannot override canonical header fields with legacy aliases inside accepts", async () => {
  const challenge = { ...V2_CHALLENGE, accepts: [{ ...V2_REQUIREMENT,
    maxAmountRequired: "90000", x402Version: 1,
    resource: { url: "https://other.example/resource" }, mimeType: "text/plain",
  }] };
  const { calls, sign } = mockChallenge(new Response(null, { status: 402, headers: {
    "PAYMENT-REQUIRED": encodeChallenge(challenge),
  } }));
  await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
  const payment = retryPayment(calls);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(payment.x402Version).toBe(2);
  expect(payment.resource).toEqual(V2_CHALLENGE.resource);
  expect(payment.accepted).toEqual(V2_REQUIREMENT);
  expect(payment.payload.authorization.value).toBe("10000");
});

const invalidHeaders: [string, string, string][] = [
  ["empty header", "", "base64-encoded JSON"],
  ["invalid base64", "!!!not-base64!!!", "base64-encoded JSON"],
  ["trailing base64 junk", encodeChallenge(V2_CHALLENGE) + "!", "base64-encoded JSON"],
  ["non-JSON payload", Buffer.from("not JSON").toString("base64"), "base64-encoded JSON"],
  ["null", encodeChallenge(null), "object"],
  ["array", encodeChallenge([]), "object"],
  ["unsupported version", encodeChallenge({ ...V2_CHALLENGE, x402Version: 3 }), "x402Version"],
  ["legacy version in header", encodeChallenge({ ...V2_CHALLENGE, x402Version: 1 }), "x402Version"],
  ["missing version", encodeChallenge({ resource: V2_CHALLENGE.resource, accepts: [V2_REQUIREMENT] }), "x402Version"],
  ["missing resource", encodeChallenge({ x402Version: 2, accepts: [V2_REQUIREMENT] }), "resource"],
  ["bare resource", encodeChallenge({ ...V2_CHALLENGE, resource: RESOURCE_URL }), "resource"],
  ["empty resource URL", encodeChallenge({ ...V2_CHALLENGE, resource: { url: "" } }), "resource"],
  ["invalid resource metadata", encodeChallenge({ ...V2_CHALLENGE, resource: { url: RESOURCE_URL, mimeType: 42 } }), "resource"],
  ["missing accepts", encodeChallenge({ x402Version: 2, resource: V2_CHALLENGE.resource }), "accepts"],
  ["non-array accepts", encodeChallenge({ ...V2_CHALLENGE, accepts: {} }), "accepts"],
  ["empty accepts", encodeChallenge({ ...V2_CHALLENGE, accepts: [] }), "accepts"],
  ["null requirement", encodeChallenge({ ...V2_CHALLENGE, accepts: [null] }), "accepts"],
  ["missing amount", encodeChallenge({ ...V2_CHALLENGE, accepts: [{ ...V2_REQUIREMENT, amount: undefined }] }), "accepts"],
  ["invalid amount", encodeChallenge({ ...V2_CHALLENGE, accepts: [{ ...V2_REQUIREMENT, amount: "-1" }] }), "accepts"],
  ["invalid timeout", encodeChallenge({ ...V2_CHALLENGE, accepts: [{ ...V2_REQUIREMENT, maxTimeoutSeconds: 0.5 }] }), "accepts"],
  ["invalid extra", encodeChallenge({ ...V2_CHALLENGE, accepts: [{ ...V2_REQUIREMENT, extra: [] }] }), "accepts"],
  ["invalid option after a payable option", encodeChallenge({ ...V2_CHALLENGE, accepts: [V2_REQUIREMENT, null] }), "accepts"],
];
for (const [name, header, reason] of invalidHeaders) {
  test(`fetchWithX402 rejects ${name} before signing instead of falling back to a payable body`, async () => {
    const response = new Response(JSON.stringify(V2_CHALLENGE), { status: 402, headers: {
      "PAYMENT-REQUIRED": header,
    } });
    const { calls, sign } = mockChallenge(response);
    await expect(fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK))
      .rejects.toThrow(`x402: invalid PAYMENT-REQUIRED header: ${reason}`);
    expect(calls).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });
}

test("fetchWithX402 does not pay a legacy body when the canonical header offers only an unsupported scheme", async () => {
  const challenge = { ...V2_CHALLENGE, accepts: [{ ...V2_REQUIREMENT, scheme: "unsupported" }] };
  const { calls, sign } = mockChallenge(new Response(JSON.stringify(V2_CHALLENGE), { status: 402, headers: {
    "PAYMENT-REQUIRED": encodeChallenge(challenge),
  } }));
  await expect(fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK))
    .rejects.toThrow("no payable option");
  expect(calls).toHaveLength(1);
  expect(sign).not.toHaveBeenCalled();
});

const unsupportedHeaderOptions: X402Requirement[] = [
  { ...V2_REQUIREMENT, scheme: "unsupported", extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } },
  { ...V2_REQUIREMENT, extra: { ...V2_REQUIREMENT.extra, assetTransferMethod: "unsupported" } },
  { ...V2_REQUIREMENT, network: "solana:unsupported" },
  { ...V2_REQUIREMENT, extra: { assetTransferMethod: "permit2", spenderAddress: SPENDER } },
  { ...V2_REQUIREMENT, scheme: "permit2", extra: { spender: SPENDER } },
];
for (const unsupported of unsupportedHeaderOptions) {
  test(`fetchWithX402 rejects an unsupported header option ${unsupported.scheme}/${unsupported.extra?.assetTransferMethod ?? "default"}@${unsupported.network} without signing`, async () => {
    const { calls, sign } = mockChallenge(new Response(JSON.stringify(V2_CHALLENGE), { status: 402, headers: {
      "PAYMENT-REQUIRED": encodeChallenge({ ...V2_CHALLENGE, accepts: [unsupported] }),
    } }));
    await expect(fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK))
      .rejects.toThrow("no payable option");
    expect(calls).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled();
  });
}

test("fetchWithX402 skips unsupported header alternatives when a supported exact option is available", async () => {
  const challenge = { ...V2_CHALLENGE, accepts: [
    { ...V2_REQUIREMENT, scheme: "upto", amount: "90000", extra: {
      assetTransferMethod: "permit2-exact", spenderAddress: SPENDER,
    } },
    { ...V2_REQUIREMENT, amount: "90000", extra: { assetTransferMethod: "permit2", spenderAddress: SPENDER } },
    V2_REQUIREMENT,
  ] };
  const { calls, sign } = mockChallenge(new Response(null, { status: 402, headers: {
    "PAYMENT-REQUIRED": encodeChallenge(challenge),
  } }));
  await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(retryPayment(calls).accepted).toEqual(V2_REQUIREMENT);
});

test("fetchWithX402 preserves a bare legacy v1 body when there is no canonical header", async () => {
  const requirement = { scheme: "exact", network: "bsc", asset: TOKEN, payTo: PAYTO,
    maxAmountRequired: "12345", extra: { name: "USD Coin", version: "2" }, x402Version: 1 };
  const { calls, sign } = mockChallenge(new Response(JSON.stringify(requirement), { status: 402 }));
  await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
  expect(sign).toHaveBeenCalledTimes(1);
  const payment = retryPayment(calls);
  expect(payment.x402Version).toBe(1);
  expect(payment.payload.authorization.value).toBe("12345");
});

test("fetchWithX402 preserves the legacy plain Permit2 body format when there is no canonical header", async () => {
  const requirement = { ...V2_REQUIREMENT, scheme: "permit2", extra: { spender: SPENDER } };
  const { calls, sign } = mockChallenge(new Response(JSON.stringify({
    x402Version: 2, accepts: [requirement],
  }), { status: 402 }));
  await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
  expect(sign).toHaveBeenCalledTimes(1);
  const payment = retryPayment(calls);
  expect(payment.x402Version).toBe(2);
  expect(payment.payload.permit.spender).toBe(SPENDER);
  expect(payment.payload.permit.permitted.amount).toBe("10000");
  expect(payment.payload.permit.witness).toBeUndefined();
});

for (const body of ["", "not JSON", "{}"]) {
  test(`fetchWithX402 never signs or retries an invalid headerless body ${JSON.stringify(body)}`, async () => {
    const { calls, sign } = mockChallenge(new Response(body, { status: 402 }));
    await expect(fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK))
      .rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled();
  });
}

test("fetchWithX402 signs a header-discovered authorization with a real unfunded synthetic signer", async () => {
  const session = makeSession(createPrivateKeySigner());
  const { calls, sign } = mockChallenge(new Response(null, { status: 402, headers: {
    "PAYMENT-REQUIRED": encodeChallenge(V2_CHALLENGE),
  } }));
  sign.mockRestore();
  await fetchWithX402(session, RESOURCE_URL, undefined, NO_APPROVAL_CHECK);
  const payment = retryPayment(calls);
  expect(calls).toHaveLength(2);
  expect(payment.payload.signature).toMatch(/^0x[0-9a-f]{196}$/i);
  expect(payment.payload.authorization.from.toLowerCase()).toBe(WALLET.toLowerCase());
});

for (const status of [200, 400, 500]) {
  test(`fetchWithX402 passes status ${status} through without inspecting a malformed payment header or signing`, async () => {
    const response = new Response("not JSON", { status, headers: { "PAYMENT-REQUIRED": "invalid" } });
    const { calls, sign } = mockChallenge(response);
    expect(await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, undefined, NO_APPROVAL_CHECK)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(sign).not.toHaveBeenCalled();
  });
}

for (const header of [undefined, encodeChallenge(V2_CHALLENGE)]) {
  test(`fetchWithX402 signs and retries only once for a ${header ? "header" : "body"} challenge even if the retry is another 402`, async () => {
    const retry = new Response("another challenge", { status: 402, headers: {
      "PAYMENT-REQUIRED": encodeChallenge(V2_CHALLENGE),
    } });
    const { calls, sign } = mockChallenge(new Response(JSON.stringify(V2_CHALLENGE), {
      status: 402, headers: header === undefined ? {} : { "PAYMENT-REQUIRED": header },
    }), retry);
    const init = { method: "POST", body: "request-body", headers: { "x-request-id": "preserved" } };
    expect(await fetchWithX402(makeSession(createPrivateKeySigner()), RESOURCE_URL, init, NO_APPROVAL_CHECK)).toBe(retry);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(retry.bodyUsed).toBe(false);
    expect(calls[1]!.init?.method).toBe("POST");
    expect(calls[1]!.init?.body).toBe("request-body");
    expect(new Headers(calls[1]!.init?.headers).get("x-request-id")).toBe("preserved");
    retryPayment(calls);
  });
}
