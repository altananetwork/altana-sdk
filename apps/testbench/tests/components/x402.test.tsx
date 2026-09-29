import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, type SerializedSession } from "@altananetwork/sdk";
import { X402Panel } from "../../src/components/X402Panel";
import type { StoredSession, StoredState } from "../../src/lib/storage";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { accountKeyHashForAddress } from "../../src/lib/permit2Setup";
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

  test("names Celo's facilitator when the seller is configured with one", async () => {
    mockFetch(() => Response.json({ price: "10000", facilitator: "https://api.x402.sepolia.celo.org" }));
    renderWith(fakeClient(), <X402Panel />, WITH_SESSION);
    expect(await screen.findByText("https://api.x402.sepolia.celo.org")).toBeInTheDocument();
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

  test("choosing the EIP-3009 rail is passed through, and its note says who can use it", async () => {
    mockFetch(() => Response.json({ price: "10000" }));
    const client = fakeClient({
      fetchWithX402: vi.fn(async () => Response.json({ rail: "eip3009", settledVia: "facilitator" })),
    });
    renderWith(client, <X402Panel />, WITH_SESSION);
    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    await userEvent.click(screen.getByRole("button", { name: "Pay and fetch" }));
    await waitFor(() => expect(client.fetchWithX402).toHaveBeenCalled());
    expect(vi.mocked(client.fetchWithX402).mock.calls[0]![0]).toMatchObject({ preferRail: "eip3009" });
    expect(await screen.findByText(/smart account cannot/)).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent(/insufficient allowance/);
    expect(screen.queryByText("Paid")).not.toBeInTheDocument();
  });
});

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

describe("X402Panel, the two Permit2 approvals", () => {
  const HEALTH = { price: "10000", token: USDC, facilitator: null };
  const both = { tokenAllowance: 2n ** 256n - 1n, checkers: [PERMIT2] as readonly `0x${string}`[] };

  test("a session missing both approvals is told which, and offered one button", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({
      permit2Readiness: vi.fn(async () => ({ tokenAllowance: 0n, checkers: [] })),
    });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    expect(await screen.findByText(/not approved to Permit2, so it cannot pull the payment/)).toBeInTheDocument();
    expect(screen.getByText(/refuses its callback and settlement reverts/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up Permit2 for this session" })).toBeEnabled();
  });

  test("the token approved but not the checker still blocks, which is the state that used to look ready", async () => {
    // This is exactly the wallet qa found reverting: allowance set, checker missing.
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({
      permit2Readiness: vi.fn(async () => ({ tokenAllowance: 2n ** 256n - 1n, checkers: [] })),
    });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    expect(await screen.findByText(/refuses its callback and settlement reverts/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot pull the payment/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set up Permit2 for this session" })).toBeInTheDocument();
  });

  test("both approvals present says so, and asks for nothing", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({ permit2Readiness: vi.fn(async () => both) });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    expect(await screen.findByText(/both halves of what the rail needs/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up Permit2 for this session" })).not.toBeInTheDocument();
  });

  test("setting up runs both calls, and the checker one is signed by the admin", async () => {
    mockFetch(() => Response.json(HEALTH));
    const readiness = vi
      .fn()
      .mockResolvedValueOnce({ tokenAllowance: 0n, checkers: [] })
      .mockResolvedValue(both);
    const client = fakeClient({ permit2Readiness: readiness as never });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });

    await userEvent.click(await screen.findByRole("button", { name: "Set up Permit2 for this session" }));
    await waitFor(() => expect(client.approvePermit2Checker).toHaveBeenCalled());
    expect(vi.mocked(client.approvePermit2Token).mock.calls[0]![0]).toMatchObject({ token: USDC });
    const checkerCall = vi.mocked(client.approvePermit2Checker).mock.calls[0]![0];
    expect(checkerCall.wallet).toBe(TEST_ADDRESS);
    // The admin signs it: setSignatureCheckerApproval is onlyThis.
    expect(checkerCall.signer.address).toBe(TEST_ADDRESS);
    expect(checkerCall.session.publicKey).toBe(SESSION_PUBLIC_KEY);
    expect(await screen.findByText(/both halves of what the rail needs/)).toBeInTheDocument();
  });

  test("an approval already in place is not sent again", async () => {
    mockFetch(() => Response.json(HEALTH));
    const readiness = vi
      .fn()
      .mockResolvedValueOnce({ tokenAllowance: 2n ** 256n - 1n, checkers: [] })
      .mockResolvedValue(both);
    const client = fakeClient({ permit2Readiness: readiness as never });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.click(await screen.findByRole("button", { name: "Set up Permit2 for this session" }));
    await waitFor(() => expect(client.approvePermit2Checker).toHaveBeenCalled());
    expect(client.approvePermit2Token).not.toHaveBeenCalled();
  });

  test("a checker approval that does not confirm is reported, not assumed", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({
      permit2Readiness: vi.fn(async () => ({ tokenAllowance: 2n ** 256n - 1n, checkers: [] })),
      approvePermit2Checker: vi.fn(async () => ({ callsId: "0x02" as const, status: "FAILED" as const })),
    });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.click(await screen.findByRole("button", { name: "Set up Permit2 for this session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/signature checker returned FAILED/);
  });

  test("the EIP-3009 rail needs neither approval, so none is asked for", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({
      permit2Readiness: vi.fn(async () => ({ tokenAllowance: 0n, checkers: [] })),
    });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Set up Permit2 for this session" })).not.toBeInTheDocument(),
    );
  });

  test("the session key hash asked about is the account's, not the KeyStore's", async () => {
    // The two differ and querying with the wrong one answers empty rather than
    // erroring, so this is the mistake that would silently show "all set".
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({ permit2Readiness: vi.fn(async () => both) });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await waitFor(() => expect(client.permit2Readiness).toHaveBeenCalled());
    const asked = vi.mocked(client.permit2Readiness).mock.calls[0]![0].sessionKeyHash;
    expect(asked).toBe(accountKeyHashForAddress(privateKeyToAccount(SESSION_KEY).address));
    expect(asked).not.toBe(keccak256(SESSION_PUBLIC_KEY));
  });
});
