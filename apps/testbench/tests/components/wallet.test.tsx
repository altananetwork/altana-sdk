import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { WalletPanel } from "../../src/components/WalletPanel";
import { STORAGE_KEY } from "../../src/lib/storage";
import { TEST_ADDRESS, TEST_KEY, USDC, fakeClient } from "../../src/test/fakeClient";
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

describe("Move all funds", () => {
  test("sends each held token in full, then native minus the fee the relay quoted", async () => {
    const client = fakeClient({
      holdings: vi.fn(async () => ({ native: 10n ** 18n, tokens: [{ address: "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as const, ok: true as const, raw: 3_000_000n, decimals: 6, symbol: "USDC", display: "3" }] })),
    });
    renderWith(client, <WalletPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(await screen.findByLabelText("Destination address"), "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    await userEvent.click(screen.getByRole("button", { name: "Move everything" }));
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(2));
    const calls = (client.execute as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls[0]).not.toHaveProperty("feeToken");
    expect((calls[0]!.calls as { to: string }[])[0]!.to).toBe("0x01C5C0122039549AD1493B8220cABEdD739BC44E");
    expect(client.quoteExecute).toHaveBeenCalledTimes(1);
    expect((calls[1]!.calls as { value: bigint }[])[0]!.value).toBe(10n ** 18n - 90_000_000_000_000_000n);
    expect(await screen.findByText(/USDC: CONFIRMED/)).toBeInTheDocument();
  });
});

describe("Move all funds re-reads what the wallet holds", () => {
  test("a token acquired after the Balances table loaded is still swept", async () => {
    // qa's fund-stranding bug: the loop used the cached table while only the
    // native leg re-read, so USDC funded after the table loaded was left
    // behind, and the second attempt failed for asset deficits because the
    // native balance was already gone.
    const client = fakeClient();
    let call = 0;
    (client.holdings as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call += 1;
      // The stale first read the table would have cached: native only.
      if (call === 1) return { native: 10n ** 18n, tokens: [] };
      // What the wallet actually holds by the time the sweep runs.
      return {
        native: 10n ** 18n,
        tokens: [{ address: USDC, ok: true, raw: 90_000n, decimals: 6, symbol: "USDC", display: "0.09" }],
      };
    });

    renderWith(client, <WalletPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await waitFor(() => expect(client.holdings).toHaveBeenCalled());

    await userEvent.type(await screen.findByLabelText("Destination address"), TEST_ADDRESS);
    await userEvent.click(screen.getByRole("button", { name: "Move everything" }));

    await waitFor(() => expect(client.execute).toHaveBeenCalled());
    const sent = vi.mocked(client.execute).mock.calls.map((c) => (c[0] as unknown as { calls: { to: string }[] }).calls[0]!.to);
    expect(sent, "the USDC transfer must be among the calls").toContain(USDC);
  });

  test("it sweeps even when the Balances table was never loaded for this chain", async () => {
    const client = fakeClient();
    (client.holdings as ReturnType<typeof vi.fn>).mockResolvedValue({
      native: 10n ** 18n,
      tokens: [{ address: USDC, ok: true, raw: 90_000n, decimals: 6, symbol: "USDC", display: "0.09" }],
    });
    renderWith(client, <WalletPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(await screen.findByLabelText("Destination address"), TEST_ADDRESS);
    await userEvent.click(screen.getByRole("button", { name: "Move everything" }));
    await waitFor(() => expect(client.execute).toHaveBeenCalled());
    const sent = vi.mocked(client.execute).mock.calls.map((c) => (c[0] as unknown as { calls: { to: string }[] }).calls[0]!.to);
    expect(sent).toContain(USDC);
  });
});
