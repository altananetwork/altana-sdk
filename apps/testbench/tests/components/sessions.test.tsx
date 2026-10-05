import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, expect, test } from "vitest";
import type { GrantSessionResult, SessionLeg } from "@altananetwork/sdk";
import { SessionsPanel } from "../../src/components/SessionsPanel";
import type { StoredSession } from "../../src/lib/storage";
import { privateKeyToAccount } from "viem/accounts";
import { TEST_ADDRESS, TEST_KEY, USDC, ZERO, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const KEY_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const legs: SessionLeg[] = [
  { chainId: 11155111, kind: "registry", status: "CONFIRMED", via: "relay", transactionHash: "0xreg", fundedFromChainId: 11142220, sourceTransactionHash: "0xsrc" },
  { chainId: 11142220, kind: "account", status: "CONFIRMED", via: "relay", transactionHash: "0xacc" },
  { chainId: 11142220, kind: "cache", status: "FAILED", reason: "anchor not ready" },
];

function grantResult(args: { permissions: GrantSessionResult["permissions"]; expiry: number; sessionSigner?: { publicKey: `0x${string}` } }): GrantSessionResult {
  return {
    walletAddress: TEST_ADDRESS,
    signer: args.sessionSigner as GrantSessionResult["signer"],
    publicKey: args.sessionSigner?.publicKey ?? "0x04",
    permissions: args.permissions,
    expiry: args.expiry,
    keyId: KEY_ID,
    status: "granted",
    legs,
    cacheSync: Promise.resolve(legs.filter((l) => l.kind === "cache")),
  };
}

function setup(client = fakeClient(), sessions: StoredSession[] = []) {
  const r = renderWith(client, <SessionsPanel />, { v: 1, walletKey: TEST_KEY, sessions });
  return { client, ...r };
}

describe("SessionsPanel", () => {
  test("grants a session with a USDC cap and fee token, stores it and shows the legs", async () => {
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockImplementation(async (o: Parameters<typeof client.grantSession>[0]) => {
      o.onStatus?.("account-authorization", { chainId: 11142220 });
      return grantResult(o as never);
    });
    const { storage } = setup(client);
    await screen.findByLabelText("Cap 1 token");
    await userEvent.type(screen.getByLabelText("Name"), "agent one");
    await userEvent.clear(screen.getByLabelText("Cap 1 amount"));
    await userEvent.type(screen.getByLabelText("Cap 1 amount"), "2.5");
    await userEvent.selectOptions(screen.getByLabelText("Cap 1 token"), USDC);
    await userEvent.click(screen.getByRole("checkbox", { name: "USDC for fees" }));
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalledTimes(1));
    const opts = (client.grantSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.permissions).toEqual({ spend: [{ limit: 2_500_000n, period: "day", token: USDC }] });
    expect(opts.chainIds).toEqual([11142220]);
    expect(opts.feeToken).toEqual([USDC]);
    expect(opts.sessionSigner).toBeDefined();
    const legsTable = await screen.findByRole("table", { name: "Legs" });
    expect(within(legsTable).getAllByText("CONFIRMED")).toHaveLength(2);
    expect(within(legsTable).getByText("anchor not ready")).toBeInTheDocument();
    expect(within(legsTable).getByText("funded from Celo Sepolia Testnet")).toBeInTheDocument();
    expect(within(legsTable).getByRole("link", { name: /0xsrc/ })).toHaveAttribute("href", "https://sepolia.celoscan.io/tx/0xsrc");
    await waitFor(() => expect(storage.dump()?.sessions).toHaveLength(1));
    const stored = storage.dump()!.sessions[0]!;
    expect(stored.name).toBe("agent one");
    expect(stored.keyId).toBe(KEY_ID);
    expect(stored.serialized.permissions.spend?.[0]).toEqual({ limit: "2500000", period: "day", token: USDC });
    expect(stored.sessionKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(screen.getByText("2.5 USDC per day", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Cache failed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show key" }));
    expect(screen.getByRole("note")).toHaveTextContent(stored.sessionKey);
  });

  test("the session key is saved before the grant returns, and a pending cache proof is followed", async () => {
    let finishCache: (legs: SessionLeg[]) => void = () => {};
    const cacheSync = new Promise<SessionLeg[]>((r) => (finishCache = r));
    let finishGrant: () => void = () => {};
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockImplementation(async (o: Parameters<typeof client.grantSession>[0]) => {
      await new Promise<void>((r) => (finishGrant = r));
      return {
        ...grantResult(o as never),
        legs: [legs[0]!, legs[1]!, { chainId: 11142220, kind: "cache" as const, status: "PENDING" as const }],
        cacheSync,
      };
    });
    const { storage } = setup(client);
    await screen.findByLabelText("Cap 1 token");
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(storage.dump()?.sessions).toHaveLength(1));
    expect(storage.dump()!.sessions[0]!.status).toBe("granting");
    expect(storage.dump()!.sessions[0]!.sessionKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(screen.getByText("Granting")).toBeInTheDocument();
    finishGrant();
    expect(await screen.findByText("Cache syncing")).toBeInTheDocument();
    expect(storage.dump()!.sessions[0]!.status).toBe("granted");
    expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled();
    finishCache([{ chainId: 11142220, kind: "cache", status: "CONFIRMED", transactionHash: "0xcache" }]);
    expect(await screen.findByText("Cache synced")).toBeInTheDocument();
    await waitFor(() => expect(storage.dump()!.sessions[0]!.legs.find((l) => l.kind === "cache")?.status).toBe("CONFIRMED"));
  });

  test("shows validation errors before calling the relay", async () => {
    const { client } = setup();
    await screen.findByLabelText("Lifetime (days)");
    await userEvent.clear(screen.getByLabelText("Lifetime (days)"));
    await userEvent.type(screen.getByLabelText("Lifetime (days)"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("positive number of days");
    expect(client.grantSession).not.toHaveBeenCalled();
  });

  test("the cost is fetched and shown when granting", async () => {
    const client = fakeClient({
      quoteGrantSession: vi.fn(async () => ({
        lines: [
          { chainId: 11142220, kind: "account" as const, payer: TEST_ADDRESS, fee: 10n ** 15n, feeToken: USDC, value: 0n, needed: 0n, neededFromRelay: false },
          { chainId: 11142220, kind: "cache" as const, payer: TEST_ADDRESS, feeToken: USDC, value: 0n, needed: 0n, neededFromRelay: false, deferred: true as const },
        ],
        balances: [{ chainId: 11142220, address: TEST_ADDRESS, symbol: "CELO", balance: 0n, needed: 10n ** 16n, sufficient: false }],
        complete: false,
      })),
    });
    (client.grantSession as ReturnType<typeof vi.fn>).mockImplementation(async (o: Parameters<typeof client.grantSession>[0]) => grantResult(o as never));
    setup(client);
    await screen.findByLabelText("Cap 1 token");
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    const table = await screen.findByRole("table", { name: "Quote balances" });
    expect(within(table).getByText("Short")).toBeInTheDocument();
    expect(screen.getByText(/priced once the registry write lands/)).toBeInTheDocument();
    expect(screen.getByText(/Cache proofs are priced once the Keystore write lands/)).toBeInTheDocument();
  });

  test("executes with a stored session and revokes it", async () => {
    const stored: StoredSession = {
      id: KEY_ID,
      name: "stored one",
      serialized: { walletAddress: TEST_ADDRESS, publicKey: privateKeyToAccount(SESSION_KEY).publicKey, permissions: { spend: [{ limit: "1000000", period: "day", token: USDC }] }, expiry: 4102444800 },
      sessionKey: SESSION_KEY,
      keyId: KEY_ID,
      legs: [],
      createdAt: 1,
    };
    const client = fakeClient({
      revokeSession: vi.fn(async () => ({ keyId: KEY_ID, status: "revoked" as const, legs: [{ chainId: 11142220, kind: "account" as const, status: "CONFIRMED" as const, transactionHash: "0xrev" as const }], cacheSync: Promise.resolve([]) })),
    });
    const { storage } = setup(client, [stored]);
    await userEvent.click(await screen.findByRole("button", { name: "Execute" }));
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(1));
    const opts = (client.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect((opts.session as { publicKey: string }).publicKey).toBe(privateKeyToAccount(SESSION_KEY).publicKey);
    expect(opts.chainId).toBe(11142220);
    expect(await screen.findByText("Charged in USDC")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(client.revokeSession).toHaveBeenCalledTimes(1));
    expect(client.quoteRevokeSession).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    await waitFor(() => expect(storage.dump()?.sessions[0]?.revokedAt).toBeDefined());
    expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
  });
});

describe("where the session key is recorded", () => {
  test("registered by default, which is the SDK's own default", async () => {
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(client);
    expect(screen.getByRole("checkbox", { name: /Write it into the Ethereum Sepolia KeyStore/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    expect(vi.mocked(client.grantSession).mock.calls[0]![0]).toMatchObject({ register: true });
  });

  test("unticking it grants an account-only session, the one that works on a live relay today", async () => {
    // Every grant went through the Ethereum KeyStore write, which is the step
    // blocked on every live relay, so the bench could not grant at all there.
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(client);
    await userEvent.click(screen.getByRole("checkbox", { name: /Write it into the Ethereum Sepolia KeyStore/ }));
    expect(screen.getByText(/nothing for the Celo mirror to show/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    expect(vi.mocked(client.grantSession).mock.calls[0]![0]).toMatchObject({ register: false });
  });

  test("the quote is priced for the same choice as the grant", async () => {
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(client);
    await userEvent.click(screen.getByRole("checkbox", { name: /Write it into the Ethereum Sepolia KeyStore/ }));
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.quoteGrantSession).toHaveBeenCalled());
    // A quote priced with the registry leg against a grant without it would
    // show the operator a cost they are not going to pay.
    expect(vi.mocked(client.quoteGrantSession).mock.calls[0]![0]).toMatchObject({ register: false });
  });
});

describe("granting a session that can pay x402", () => {
  test("ticking a token approves both of its signature checkers in the same grant", async () => {
    // Without this the session is granted and cannot pay, and the failure
    // arrives later as an invalid-signature revert with nothing naming the
    // missing approval (evidence/2026-10-05-x402-session-approvals.md).
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(client);
    await userEvent.click(await screen.findByRole("checkbox", { name: "USDC for x402" }));
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    expect(vi.mocked(client.grantSession).mock.calls[0]![0]).toMatchObject({ x402Tokens: [USDC] });
  });

  test("a session not meant for x402 sends no x402Tokens at all", async () => {
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(client);
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    expect(vi.mocked(client.grantSession).mock.calls[0]![0]).not.toHaveProperty("x402Tokens");
  });
});

describe("which tokens a session can be granted x402 for", () => {
  /** The live relay: the oracle is gate G1, so it lists no ERC-20 fee tokens. */
  const feeTokensEmpty = fakeClient({
    feeCurrencies: vi.fn(async (chainId) => ({
      chainId,
      currencies: [{ uid: "native", address: ZERO, symbol: "S-CELO", decimals: 18, nativeRate: 10n ** 18n, isNative: true }],
      rateTtl: 300,
    })),
  });

  test("the list survives a relay that accepts no ERC-20 fees, because it is not the fee list", async () => {
    // Sourcing it from fee currencies left nothing to tick on the live relay,
    // so a session could not be granted x402-ready at all (qa, 2026-10-05).
    // What a seller charges in has nothing to do with what the relay takes for
    // gas, and that list is empty for an unrelated reason: gate G1.
    (feeTokensEmpty.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(feeTokensEmpty);
    const usdc = await screen.findByRole("checkbox", { name: "USDC for x402" });
    expect(usdc).toBeInTheDocument();
    // And no fee-token checkbox exists at all, which is the state that broke it.
    expect(screen.queryByRole("checkbox", { name: "USDC for fees" })).not.toBeInTheDocument();

    await userEvent.click(usdc);
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(feeTokensEmpty.grantSession).toHaveBeenCalled());
    expect(vi.mocked(feeTokensEmpty.grantSession).mock.calls[0]![0]).toMatchObject({ x402Tokens: [USDC] });
  });

  test("a token neither list anticipated can be typed in", async () => {
    const client = fakeClient();
    (client.grantSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      grantResult({ permissions: { spend: [] }, expiry: 0 }),
    );
    setup(client);
    const other = "0x1111111111111111111111111111111111111111";
    await userEvent.type(screen.getByLabelText(/Another token to pay x402 with/), other);
    await userEvent.click(screen.getByRole("button", { name: "Grant session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    expect(vi.mocked(client.grantSession).mock.calls[0]![0]).toMatchObject({ x402Tokens: [other] });
  });

  test("a half-typed address is named and not sent", async () => {
    const client = fakeClient();
    setup(client);
    await userEvent.type(screen.getByLabelText(/Another token to pay x402 with/), "0x123");
    expect(await screen.findByText("That is not an address.")).toBeInTheDocument();
  });
});
