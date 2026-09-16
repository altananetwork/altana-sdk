import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, expect, test } from "vitest";
import type { GrantSessionResult, SessionLeg } from "@altananetwork/sdk";
import { SessionsPanel } from "../../src/components/SessionsPanel";
import type { StoredSession } from "../../src/lib/storage";
import { privateKeyToAccount } from "viem/accounts";
import { TEST_ADDRESS, TEST_KEY, USDC, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const KEY_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

const legs: SessionLeg[] = [
  { chainId: 11155111, kind: "registry", status: "CONFIRMED", via: "relay", transactionHash: "0xreg" },
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
    await userEvent.click(screen.getByLabelText("USDC"));
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
    await waitFor(() => expect(storage.dump()?.sessions).toHaveLength(1));
    const stored = storage.dump()!.sessions[0]!;
    expect(stored.name).toBe("agent one");
    expect(stored.keyId).toBe(KEY_ID);
    expect(stored.serialized.permissions.spend?.[0]).toEqual({ limit: "2500000", period: "day", token: USDC });
    expect(stored.sessionKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(screen.getByText("2.5 USDC per day", { exact: false })).toBeInTheDocument();
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

  test("quote renders lines and balance sufficiency", async () => {
    const client = fakeClient({
      quoteGrantSession: vi.fn(async () => ({
        lines: [{ chainId: 11142220, kind: "account" as const, payer: TEST_ADDRESS, fee: 10n ** 15n, feeToken: USDC, value: 0n, needed: 0n, neededFromRelay: false }],
        balances: [{ chainId: 11142220, address: TEST_ADDRESS, symbol: "CELO", balance: 0n, needed: 10n ** 16n, sufficient: false }],
        complete: false,
      })),
    });
    setup(client);
    await userEvent.click(await screen.findByRole("button", { name: "Quote first" }));
    const table = await screen.findByRole("table", { name: "Quote balances" });
    expect(within(table).getByText("Short")).toBeInTheDocument();
    expect(screen.getByText(/could not be quoted/)).toBeInTheDocument();
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
      revokeSession: vi.fn(async () => ({ keyId: KEY_ID, status: "revoked" as const, legs: [{ chainId: 11142220, kind: "account" as const, status: "CONFIRMED" as const, transactionHash: "0xrev" as const }] })),
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
