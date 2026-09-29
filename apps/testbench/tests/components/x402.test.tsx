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

describe("X402Panel, the Permit2 approval", () => {
  const HEALTH = { price: "10000", token: USDC, facilitator: null };

  test("a wallet that has not approved Permit2 is told, and offered the approval", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({ permit2Allowance: vi.fn(async () => 0n) });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    expect(await screen.findByText(/has not approved Permit2 for that token/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve Permit2 for this token" })).toBeEnabled();
  });

  test("a wallet that has approved is not nagged", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({ permit2Allowance: vi.fn(async () => 2n ** 256n - 1n) });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await waitFor(() => expect(client.permit2Allowance).toHaveBeenCalled());
    expect(screen.queryByText(/has not approved Permit2/)).not.toBeInTheDocument();
  });

  test("approving sends the call and re-reads the allowance", async () => {
    mockFetch(() => Response.json(HEALTH));
    const allowance = vi.fn().mockResolvedValueOnce(0n).mockResolvedValue(2n ** 256n - 1n);
    const client = fakeClient({ permit2Allowance: allowance as never });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });

    await userEvent.click(await screen.findByRole("button", { name: "Approve Permit2 for this token" }));
    await waitFor(() => expect(client.approvePermit2).toHaveBeenCalled());
    expect(vi.mocked(client.approvePermit2).mock.calls[0]![0]).toMatchObject({
      chainId: CELO_SEPOLIA.chainId,
      token: USDC,
    });
    await waitFor(() => expect(screen.queryByText(/has not approved Permit2/)).not.toBeInTheDocument());
  });

  test("an approval that does not confirm is reported, not assumed", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({
      permit2Allowance: vi.fn(async () => 0n),
      approvePermit2: vi.fn(async () => ({ callsId: "0x01" as const, status: "FAILED" as const })),
    });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.click(await screen.findByRole("button", { name: "Approve Permit2 for this token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/approval returned FAILED/);
  });

  test("the EIP-3009 rail needs no approval, so none is asked for", async () => {
    mockFetch(() => Response.json(HEALTH));
    const client = fakeClient({ permit2Allowance: vi.fn(async () => 0n) });
    renderWith(client, <X402Panel />, { ...WITH_SESSION, walletKey: TEST_KEY });
    await userEvent.selectOptions(screen.getByLabelText(/Preferred rail/), "eip3009");
    await waitFor(() => expect(screen.queryByText(/has not approved Permit2/)).not.toBeInTheDocument());
  });
});
