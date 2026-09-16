import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { SendPanel } from "../../src/components/SendPanel";
import { WalletPanel } from "../../src/components/WalletPanel";
import { EURM, TEST_ADDRESS, TEST_KEY, USDC, ZERO, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function setup(client = fakeClient()) {
  renderWith(
    client,
    <>
      <WalletPanel />
      <SendPanel />
    </>,
    { v: 1, walletKey: TEST_KEY, sessions: [] },
  );
  return client;
}

async function fillAndSend(feeMode?: "one" | "list", picks: string[] = []) {
  await userEvent.type(await screen.findByLabelText("Recipient"), RECIPIENT);
  if (feeMode === "one") {
    await userEvent.click(screen.getByLabelText("Force one token"));
    await userEvent.selectOptions(screen.getByLabelText("Fee token"), picks[0]!);
  }
  if (feeMode === "list") {
    await userEvent.click(screen.getByLabelText(/Choose from a list/));
    for (const p of picks) await userEvent.click(screen.getByLabelText(p));
  }
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("SendPanel", () => {
  test("automatic mode sends no feeToken and shows what was charged", async () => {
    const client = setup();
    await fillAndSend();
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(1));
    const opts = (client.execute as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("feeToken");
    expect(opts.chainId).toBe(11142220);
    expect((opts.wallet as { address: string }).address).toBe(TEST_ADDRESS);
    expect(await screen.findByText("USDC", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("CONFIRMED")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View transaction" })).toHaveAttribute("href", "https://sepolia.celoscan.io/tx/0xabc");
  });

  test("force one token passes that address", async () => {
    const client = setup();
    await fillAndSend("one", ["EURm"]);
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(1));
    const opts = (client.execute as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.feeToken).toBe(EURM);
  });

  test("list mode passes the tokens in the order ticked", async () => {
    const client = setup();
    await fillAndSend("list", ["USDC", "CELO", "EURm"]);
    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(1));
    const opts = (client.execute as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.feeToken).toEqual([USDC, ZERO, EURM]);
  });

  test("rejects a bad recipient before calling the relay", async () => {
    const client = setup();
    await userEvent.type(await screen.findByLabelText("Recipient"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recipient must be an address");
    expect(client.execute).not.toHaveBeenCalled();
  });
});
