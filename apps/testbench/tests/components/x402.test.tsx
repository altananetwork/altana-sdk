import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, type SerializedSession } from "@altananetwork/sdk";
import { X402Panel } from "../../src/components/X402Panel";
import type { StoredSession, StoredState } from "../../src/lib/storage";
import { privateKeyToAccount } from "viem/accounts";
import { TEST_ADDRESS, TEST_KEY, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const USDC = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const SESSION_PUBLIC_KEY = privateKeyToAccount(SESSION_KEY).publicKey;

const serialized: SerializedSession = {
  walletAddress: TEST_ADDRESS,
  publicKey: SESSION_PUBLIC_KEY,
  permissions: { spend: [] },
  expiry: 2_000_000_000,
};

const session: StoredSession = {
  id: "s1",
  name: "bench session",
  serialized,
  sessionKey: SESSION_KEY,
  keyId: "0x11",
  legs: [],
  createdAt: 0,
  status: "granted",
};

const WITH_SESSION: StoredState = { v: 1, sessions: [session] };

const permit2Req = {
  scheme: "exact",
  network: "eip155:11142220",
  asset: USDC,
  maxAmountRequired: "10000",
  payTo: "0xabc",
  resource: "http://127.0.0.1:4021/paid",
  extra: { assetTransferMethod: "permit2-exact", name: "USDC", version: "2" },
};

function mockFetch(handler: (url: string) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => handler(String(input)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("X402Panel", () => {
  test("shows the seller's terms when one is running", async () => {
    mockFetch((url) =>
      url.endsWith("/health")
        ? Response.json({ chainId: 11142220, payTo: "0xseller", price: "10000", facilitator: null })
        : new Response("", { status: 404 }),
    );
    renderWith(fakeClient(), <X402Panel />, WITH_SESSION);
    expect(await screen.findByText("0.01 USDC per request")).toBeInTheDocument();
    expect(screen.getByText(/its own key, because X402_CELO_API_KEY is not set/)).toBeInTheDocument();
  });

  test("reports which rails the seller routes, rather than assuming the split", async () => {
    // The panel used to hardcode "Settles EIP-3009 through", baking this
    // seller's configuration into the UI as though it were a property of the
    // facilitator.
    mockFetch(() =>
      Response.json({
        price: "10000",
        facilitator: "https://api.x402.sepolia.celo.org",
        facilitatorRails: ["eip3009"],
      }),
    );
    renderWith(fakeClient(), <X402Panel />, WITH_SESSION);
    expect(await screen.findByText("https://api.x402.sepolia.celo.org")).toBeInTheDocument();
    expect(screen.getByText(/eip3009 at/)).toBeInTheDocument();
    expect(screen.queryByText(/Settles EIP-3009 through/)).not.toBeInTheDocument();
  });

  test("a seller routing both rails says both, with no code change here", async () => {
    mockFetch(() =>
      Response.json({
        price: "10000",
        facilitator: "https://api.x402.sepolia.celo.org",
        facilitatorRails: ["eip3009", "permit2-exact"],
      }),
    );
    renderWith(fakeClient(), <X402Panel />, WITH_SESSION);
    expect(await screen.findByText(/eip3009, permit2-exact at/)).toBeInTheDocument();
  });

  test("no seller running says how to start one", async () => {
    mockFetch(() => {
      throw new Error("fetch failed");
    });
    renderWith(fakeClient(), <X402Panel />, WITH_SESSION);
    expect(await screen.findByText(/Start one with bun run serve:x402-celo/)).toBeInTheDocument();
  });

  test("asking what it charges lists the options and marks the chosen one", async () => {
    mockFetch((url) =>
      url.endsWith("/health")
        ? Response.json({ price: "10000" })
        : new Response(JSON.stringify({ x402Version: 2, accepts: [permit2Req] }), { status: 402 }),
    );
    renderWith(fakeClient(), <X402Panel />, WITH_SESSION);
    await userEvent.click(screen.getByRole("button", { name: "Ask what it charges" }));
    expect(await screen.findByText("Chosen")).toBeInTheDocument();
    expect(screen.getByText("x402 version 2")).toBeInTheDocument();
  });

  test("a URL that is not a paid route is called out, and nothing is paid", async () => {
    mockFetch((url) =>
      url.endsWith("/health") ? Response.json({ price: "10000" }) : new Response("hello", { status: 200 }),
    );
    const client = fakeClient();
    renderWith(client, <X402Panel />, WITH_SESSION);
    await userEvent.click(screen.getByRole("button", { name: "Ask what it charges" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/answered 200, not 402/);
    expect(client.fetchWithX402).not.toHaveBeenCalled();
  });

  test("paying passes the chosen rail and Celo's chain, and reports which rail carried it", async () => {
    mockFetch(() => Response.json({ price: "10000" }));
    const client = fakeClient({
      fetchWithX402: vi.fn(async () =>
        Response.json({
          data: "the paid answer",
          rail: "permit2-exact",
          settledVia: "merchant key",
          settlement: "confirmed",
          txHash: "0xsettle",
        }),
      ),
    });
    renderWith(client, <X402Panel />, WITH_SESSION);
    await userEvent.click(screen.getByRole("button", { name: "Pay and fetch" }));
    await waitFor(() => expect(client.fetchWithX402).toHaveBeenCalled());
    expect(vi.mocked(client.fetchWithX402).mock.calls[0]![0]).toMatchObject({
      preferRail: "permit2",
      chainId: CELO_SEPOLIA.chainId,
    });
    expect(await screen.findByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("permit2-exact")).toBeInTheDocument();
    expect(screen.getByText("settled by the merchant key")).toBeInTheDocument();
    expect(screen.getByText(/ERC-1271/)).toBeInTheDocument();
  });

  test("choosing the EIP-3009 rail is passed through, and its note names the verifying contract", async () => {
    mockFetch(() => Response.json({ price: "10000" }));
    const client = fakeClient({
      fetchWithX402: vi.fn(async () => Response.json({ rail: "eip3009", settledVia: "facilitator" })),
    });
    renderWith(client, <X402Panel />, WITH_SESSION);
    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    await userEvent.click(screen.getByRole("button", { name: "Pay and fetch" }));
    await waitFor(() => expect(client.fetchWithX402).toHaveBeenCalled());
    expect(vi.mocked(client.fetchWithX402).mock.calls[0]![0]).toMatchObject({ preferRail: "eip3009" });
    // Corrected: a smart account CAN pay on this rail; what it needs is the
    // token approved as its signature checker.
    expect(await screen.findByText(/the token is the contract that verifies/)).toBeInTheDocument();
    expect(screen.getByText("settled by the facilitator")).toBeInTheDocument();
  });

  test("with no session the pay button is off and it says where to get one", async () => {
    mockFetch(() => Response.json({ price: "10000" }));
    renderWith(fakeClient(), <X402Panel />, { v: 1, sessions: [] });
    expect(screen.getByRole("button", { name: "Pay and fetch" })).toBeDisabled();
    expect(screen.getByText(/Grant a session on the Sessions tab first/)).toBeInTheDocument();
  });

  test("a failed payment is reported, and no receipt is shown", async () => {
    mockFetch(() => Response.json({ price: "10000" }));
    const client = fakeClient({
      fetchWithX402: vi.fn(async () => {
        throw new Error("payment rejected: insufficient allowance");
      }),
    });
    renderWith(client, <X402Panel />, WITH_SESSION);
    await userEvent.click(screen.getByRole("button", { name: "Pay and fetch" }));
    // Scoped by text: the auto-probe also reports that this URL is not a paid
    // route, which is a second, correct alert.
    expect(await screen.findByText(/insufficient allowance/)).toBeInTheDocument();
    expect(screen.queryByText("Paid")).not.toBeInTheDocument();
  });
});

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

const PERMIT2_ADDR = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

describe("X402Panel, the approvals a rail needs", () => {
  const HEALTH = { price: "10000", token: USDC, facilitator: null };
  const ok = {
    ok: true,
    rail: "permit2" as const,
    token: USDC,
    checker: PERMIT2_ADDR,
    keyHash: "0x11" as const,
    isSuperAdmin: false,
    permit2Allowance: { needed: 10_000n, actual: 2n ** 256n - 1n, ok: true },
    checkerApproved: true,
    missing: [] as string[],
  };

  function probed(status: Record<string, unknown>) {
    mockFetch((url) =>
      url.endsWith("/health")
        ? Response.json(HEALTH)
        : new Response(JSON.stringify({ x402Version: 2, accepts: [permit2Req] }), { status: 402 }),
    );
    return fakeClient({ x402Approvals: vi.fn(async () => status as never) });
  }

  async function ask(client: ReturnType<typeof fakeClient>) {
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.click(await screen.findByRole("button", { name: "Ask what it charges" }));
  }

  test("the eip3009 rail asks for the TOKEN as checker, which it used to ask nothing for", async () => {
    // The panel modelled eip3009 as needing no approval. It needs the token
    // itself approved as the key's signature checker, and without it the
    // payment fails with FiatTokenV2: invalid signature and no guidance
    // (evidence/2026-10-05-celo-usdc-does-honour-erc1271.md).
    const client = probed({
      ...ok,
      ok: false,
      rail: "eip3009",
      checker: USDC,
      permit2Allowance: undefined,
      checkerApproved: false,
      missing: ["approve the token as a signature checker for this key"],
    });
    await ask(client);
    expect(await screen.findByText(/not set up for the eip3009 rail/)).toBeInTheDocument();
    expect(screen.getByText(/approve the token as a signature checker/)).toBeInTheDocument();
    // The checker named is the token, not Permit2.
    expect(screen.getByText(USDC, { exact: false })).toBeInTheDocument();
  });

  test("a missing Permit2 allowance is named as itself, not as a generic failure", async () => {
    const client = probed({
      ...ok,
      ok: false,
      permit2Allowance: { needed: 10_000n, actual: 0n, ok: false },
      missing: ["approve the token to Permit2 so it can pull the payment"],
    });
    await ask(client);
    expect(await screen.findByText(/so it can pull the payment/)).toBeInTheDocument();
  });

  test("a super-admin key needs no checker approval, and the panel says why", async () => {
    const client = probed({ ...ok, isSuperAdmin: true });
    await ask(client);
    expect(await screen.findByText(/super admin, which the account accepts from any contract/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve them for this session" })).not.toBeInTheDocument();
  });

  test("both approvals present says which checker is approved for which rail", async () => {
    const client = probed(ok);
    await ask(client);
    expect(await screen.findByText(/can verify this key's signatures on the permit2 rail/)).toBeInTheDocument();
  });

  test("repairing approves the checker the SDK named, not Permit2 by assumption", async () => {
    const client = probed({
      ...ok,
      ok: false,
      rail: "eip3009",
      checker: USDC,
      permit2Allowance: undefined,
      checkerApproved: false,
      missing: ["approve the token as a signature checker for this key"],
    });
    await ask(client);
    await userEvent.click(await screen.findByRole("button", { name: "Approve them for this session" }));
    await waitFor(() => expect(client.approveX402Checker).toHaveBeenCalled());
    expect(vi.mocked(client.approveX402Checker).mock.calls[0]![0].checker).toBe(USDC);
  });

  test("the banner points at the grant-time fix rather than making repair the main path", async () => {
    const client = probed({ ...ok, ok: false, checkerApproved: false, missing: ["approve Permit2"] });
    await ask(client);
    expect(await screen.findByText(/x402 tokens ticked needs none of this/)).toBeInTheDocument();
  });
});

describe("a failed payment through the facilitator", () => {
  test("the unmapped revert is explained, and the facilitator is not blamed for it", async () => {
    mockFetch(() => Response.json({ price: "10000", token: USDC, facilitator: null }));
    const client = fakeClient({
      fetchWithX402: vi.fn(async () => {
        throw new Error("unexpected_error: execution reverted: FiatTokenV2: invalid signature");
      }),
    });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.click(await screen.findByRole("button", { name: "Pay and fetch" }));

    const alert = (await screen.findByText(/not an approved signature checker/)).closest(".banner")!;
    expect(alert).toHaveTextContent(/chain's answer relayed/);
    // The chain's own words are kept, not replaced.
    expect(alert).toHaveTextContent(/FiatTokenV2: invalid signature/);
  });
});

describe("the approval readout and the payment agree on the rail", () => {
  const eip3009Only = { ...permit2Req, extra: { ...permit2Req.extra, assetTransferMethod: "eip3009" } };
  const HEALTH = { price: "10000", token: USDC, facilitator: null };

  function sellerOfferingBoth(approvals: (req: { extra?: { assetTransferMethod?: string } }) => unknown) {
    mockFetch((url) =>
      url.endsWith("/health")
        ? Response.json(HEALTH)
        : new Response(JSON.stringify({ x402Version: 2, accepts: [permit2Req, eip3009Only] }), { status: 402 }),
    );
    return fakeClient({ x402Approvals: vi.fn(async ({ req }) => approvals(req) as never) });
  }

  /** The state qa hit: Permit2 approved as a checker, the token not. */
  const byRail = (req: { extra?: { assetTransferMethod?: string } }) => {
    const isPermit2 = req.extra?.assetTransferMethod?.startsWith("permit2");
    return {
      ok: isPermit2,
      rail: isPermit2 ? "permit2" : "eip3009",
      token: USDC,
      checker: isPermit2 ? PERMIT2_ADDR : USDC,
      keyHash: "0x11",
      isSuperAdmin: false,
      ...(isPermit2 ? { permit2Allowance: { needed: 10_000n, actual: 2n ** 256n - 1n, ok: true } } : {}),
      checkerApproved: isPermit2,
      missing: isPermit2 ? [] : ["approve the token as a signature checker for this key"],
    };
  };

  test("switching the rail moves the readout with it, instead of contradicting the payment", async () => {
    // The panel said "approved ... on the permit2 rail" while refusing an
    // eip3009 payment, both true of different rails (qa, 2026-10-05).
    const client = sellerOfferingBoth(byRail);
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });

    expect(await screen.findByText(/on the permit2 rail/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    expect(await screen.findByText(/not set up for the eip3009 rail/)).toBeInTheDocument();
    // The approved-on-permit2 sentence is gone, not sitting beside it.
    expect(screen.queryByText(/on the permit2 rail/)).not.toBeInTheDocument();
  });

  test("switching the rail does not ask the seller again", async () => {
    const client = sellerOfferingBoth(byRail);
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await screen.findByText(/on the permit2 rail/);
    const before = vi.mocked(globalThis.fetch).mock.calls.length;

    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    await screen.findByText(/not set up for the eip3009 rail/);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
  });

  test("the approval state is on screen before anything is pressed", async () => {
    // Otherwise the first signal that a session cannot pay is the refusal, and
    // on stage the panel looks ready when it is not.
    const client = sellerOfferingBoth(byRail);
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    expect(await screen.findByText(/on the permit2 rail/)).toBeInTheDocument();
    expect(client.x402Approvals).toHaveBeenCalled();
  });

  test("the requirement the payment uses is the one the readout described", async () => {
    const client = sellerOfferingBoth(byRail);
    (client.fetchWithX402 as ReturnType<typeof vi.fn>).mockResolvedValue(Response.json({ rail: "eip3009" }));
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await screen.findByText(/on the permit2 rail/);

    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    await screen.findByText(/not set up for the eip3009 rail/);
    await userEvent.click(screen.getByRole("button", { name: "Pay and fetch" }));

    await waitFor(() => expect(client.fetchWithX402).toHaveBeenCalled());
    expect(vi.mocked(client.fetchWithX402).mock.calls[0]![0]).toMatchObject({ preferRail: "eip3009" });
    const lastChecked = vi.mocked(client.x402Approvals).mock.calls.at(-1)![0].req;
    expect(lastChecked.extra).toMatchObject({ assetTransferMethod: "eip3009" });
  });
});
