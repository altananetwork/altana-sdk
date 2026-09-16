import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { WalletPanel } from "../../src/components/WalletPanel";
import { STORAGE_KEY } from "../../src/lib/storage";
import { TEST_ADDRESS, TEST_KEY, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

describe("WalletPanel", () => {
  test("generates a key, persists it and loads balances for the default chain", async () => {
    const client = fakeClient();
    const { storage } = renderWith(client, <WalletPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Generate a new key" }));
    await waitFor(() => expect(storage.dump()?.walletKey).toMatch(/^0x[0-9a-f]{64}$/));
    await waitFor(() => expect(client.holdings).toHaveBeenCalledWith(expect.any(String), 11142220));
    const balances = (await screen.findByText("Balances")).closest(".card") as HTMLElement;
    expect(await within(balances).findByText("USDC", { exact: false })).toBeInTheDocument();
    expect(within(balances).getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Not registered yet")).toBeInTheDocument();
  });

  test("rejects a malformed pasted key and accepts a valid one", async () => {
    const client = fakeClient();
    renderWith(client, <WalletPanel />);
    await userEvent.type(screen.getByLabelText("Or paste a private key"), "0xabc");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByRole("alert")).toHaveTextContent("64 hex characters");
    await userEvent.clear(screen.getByLabelText("Or paste a private key"));
    await userEvent.type(screen.getByLabelText("Or paste a private key"), TEST_KEY);
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(TEST_ADDRESS)).toBeInTheDocument();
  });

  test("registers with the relay and switching chain re-queries holdings", async () => {
    const client = fakeClient();
    const { storage } = renderWith(client, <WalletPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await waitFor(() => expect(client.holdings).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Register with relay" }));
    expect(await screen.findByText("Registered with relay")).toBeInTheDocument();
    expect(client.createWallet).toHaveBeenCalledTimes(1);
    await userEvent.selectOptions(screen.getByLabelText("Active chain"), "84532");
    await waitFor(() => expect(client.holdings).toHaveBeenLastCalledWith(TEST_ADDRESS, 84532));
    expect(storage.dump()?.chainId).toBe(84532);
  });

  test("forget key clears storage after confirmation", async () => {
    const client = fakeClient();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { storage } = renderWith(client, <WalletPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.click(await screen.findByRole("button", { name: "Forget key" }));
    expect(screen.getByRole("button", { name: "Generate a new key" })).toBeInTheDocument();
    expect(storage.dump()?.walletKey).toBeUndefined();
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  test("shows the Celo Sepolia funding table with the fee tokens", async () => {
    renderWith(fakeClient(), <WalletPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    const table = (await screen.findByText("Where to get it")).closest("table")!;
    expect(within(table).getByText("EURm", { exact: false })).toBeInTheDocument();
    expect(within(table).getAllByText("Mento app").length).toBeGreaterThan(0);
  });
});
