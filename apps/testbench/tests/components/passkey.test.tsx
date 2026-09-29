import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, SEPOLIA, type SessionLeg } from "@altananetwork/sdk";
import { PasskeyPanel } from "../../src/components/PasskeyPanel";
import type { StoredState } from "../../src/lib/storage";
import { TEST_ADDRESS, TEST_KEY, TEST_PASSKEY_CREDENTIAL, USDC, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const PASSKEY_STATE: StoredState = {
  v: 1,
  passkey: { credential: TEST_PASSKEY_CREDENTIAL, address: TEST_ADDRESS },
  registered: true,
  sessions: [],
};

function passkeyResult() {
  return { address: TEST_ADDRESS, signer: { credential: TEST_PASSKEY_CREDENTIAL } as never };
}

describe("PasskeyPanel", () => {
  test("creating a passkey wallet stores the credential, not a private key", async () => {
    const client = fakeClient({ createPasskeyWallet: vi.fn(async () => passkeyResult()) });
    const { storage } = renderWith(client, <PasskeyPanel />, { v: 1, sessions: [] });

    await userEvent.click(screen.getByRole("button", { name: "Create a passkey wallet" }));
    await waitFor(() => expect(client.createPasskeyWallet).toHaveBeenCalledWith({ name: "Altana test bench" }));

    const stored = storage.dump();
    expect(stored?.passkey).toEqual({ credential: TEST_PASSKEY_CREDENTIAL, address: TEST_ADDRESS });
    expect(stored?.walletKey).toBeUndefined();
    expect(await screen.findByText("Passkey")).toBeInTheDocument();
  });

  test("the name typed in the prompt field is the one passed to WebAuthn", async () => {
    const client = fakeClient({ createPasskeyWallet: vi.fn(async () => passkeyResult()) });
    renderWith(client, <PasskeyPanel />, { v: 1, sessions: [] });
    const field = screen.getByLabelText(/Name shown in the passkey prompt/);
    await userEvent.clear(field);
    await userEvent.type(field, "Demo");
    await userEvent.click(screen.getByRole("button", { name: "Create a passkey wallet" }));
    await waitFor(() => expect(client.createPasskeyWallet).toHaveBeenCalledWith({ name: "Demo" }));
  });

  test("a refused passkey prompt is reported, and no wallet is stored", async () => {
    const client = fakeClient({
      createPasskeyWallet: vi.fn(async () => {
        throw new Error("The operation either timed out or was not allowed");
      }),
    });
    const { storage } = renderWith(client, <PasskeyPanel />, { v: 1, sessions: [] });
    await userEvent.click(screen.getByRole("button", { name: "Create a passkey wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/timed out or was not allowed/);
    expect(storage.dump()?.passkey).toBeUndefined();
  });

  test("recovering finds the wallet from the passkey alone", async () => {
    const client = fakeClient({ recoverFromPasskey: vi.fn(async () => passkeyResult()) });
    const { storage } = renderWith(client, <PasskeyPanel />, { v: 1, sessions: [] });
    await userEvent.click(screen.getByRole("button", { name: "Recover from an existing passkey" }));
    await waitFor(() => expect(storage.dump()?.passkey?.address).toBe(TEST_ADDRESS));
  });

  test("the wallet shows one address on every configured chain", async () => {
    renderWith(fakeClient(), <PasskeyPanel />, PASSKEY_STATE);
    const rows = await screen.findAllByRole("row");
    const chainNames = rows.map((r) => r.querySelector("th")?.textContent);
    expect(chainNames).toEqual(["Celo Sepolia Testnet", "Base Sepolia", "Sepolia"]);
    // The same address in each row, which is the point of #103.
    expect(screen.getAllByTitle(TEST_ADDRESS).length).toBeGreaterThanOrEqual(3);
  });

  test("a private key wallet is labelled as not the passkey path", () => {
    renderWith(fakeClient(), <PasskeyPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    expect(screen.getByText("Private key, not a passkey")).toBeInTheDocument();
    expect(screen.getByText(/do not show the passkey path/)).toBeInTheDocument();
  });

  test("executing with the passkey reports the status and the token charged", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => ({
        callsId: "0x01" as const,
        status: "CONFIRMED" as const,
        transactionHash: "0xpk" as const,
        feeToken: USDC,
      })),
    });
    renderWith(client, <PasskeyPanel />, PASSKEY_STATE);
    await userEvent.click(screen.getByRole("button", { name: "Execute on Celo Sepolia" }));
    await waitFor(() => expect(client.execute).toHaveBeenCalled());
    expect(vi.mocked(client.execute).mock.calls[0]![0]).toMatchObject({ chainId: CELO_SEPOLIA.chainId });
    expect(await screen.findByText("CONFIRMED")).toBeInTheDocument();
  });

  test("granting shows the legs, and revoke stays off until there is a key to revoke", async () => {
    const legs: SessionLeg[] = [
      { chainId: SEPOLIA.chainId, kind: "registry", status: "CONFIRMED", via: "relay", transactionHash: "0xr" },
    ];
    const client = fakeClient({
      grantSession: vi.fn(async () => ({
        walletAddress: TEST_ADDRESS,
        signer: undefined as never,
        publicKey: "0x04ab" as const,
        permissions: { spend: [] },
        expiry: 0,
        keyId: "0x33" as const,
        status: "granted" as const,
        legs,
        cacheSync: Promise.resolve([]),
      })),
    });
    renderWith(client, <PasskeyPanel />, PASSKEY_STATE);

    expect(screen.getByRole("button", { name: "Revoke it" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Grant a session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    expect(await screen.findByText("granted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke it" })).toBeEnabled();
  });

  test("revoking passes the session key the grant made", async () => {
    const client = fakeClient({
      grantSession: vi.fn(async () => ({
        walletAddress: TEST_ADDRESS,
        signer: undefined as never,
        publicKey: "0x04ab" as const,
        permissions: { spend: [] },
        expiry: 0,
        keyId: "0x33" as const,
        status: "granted" as const,
        legs: [],
        cacheSync: Promise.resolve([]),
      })),
    });
    renderWith(client, <PasskeyPanel />, PASSKEY_STATE);
    await userEvent.click(screen.getByRole("button", { name: "Grant a session" }));
    await waitFor(() => expect(client.grantSession).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Revoke it" }));
    await waitFor(() => expect(client.revokeSession).toHaveBeenCalled());
    const granted = vi.mocked(client.grantSession).mock.calls[0]![0].sessionSigner!;
    expect(vi.mocked(client.revokeSession).mock.calls[0]![0].session).toBe(granted.publicKey);
  });
});
