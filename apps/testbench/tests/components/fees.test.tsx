import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FeeTokensPanel } from "../../src/components/FeeTokensPanel";
import { WalletPanel } from "../../src/components/WalletPanel";
import { TEST_KEY, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

describe("FeeTokensPanel", () => {
  test("lists the relay's fee tokens with rates both ways and marks held ones", async () => {
    const client = fakeClient();
    renderWith(
      client,
      <>
        <WalletPanel />
        <FeeTokensPanel />
      </>,
      { v: 1, walletKey: TEST_KEY, sessions: [] },
    );
    const usdcRow = (await screen.findByText("1 USDC = 0.666666 CELO")).closest("tr")!;
    expect(within(usdcRow).getByText("1 CELO = 1.5 USDC")).toBeInTheDocument();
    expect(within(usdcRow).getByText("Held")).toBeInTheDocument();
    const eurmRow = screen.getByText("1 EURm = 14.428785 CELO").closest("tr")!;
    expect(within(eurmRow).getByText("Not held")).toBeInTheDocument();
    expect(screen.getByText(/older than 300 seconds/)).toBeInTheDocument();
    expect(client.feeCurrencies).toHaveBeenCalledWith(11142220);
  });
});
