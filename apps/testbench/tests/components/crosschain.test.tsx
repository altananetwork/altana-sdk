import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CrossChainPanel } from "../../src/components/CrossChainPanel";
import type { CrossChainDeps } from "../../src/lib/crossChain";
import { TEST_KEY, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

function deps(over: Partial<CrossChainDeps> = {}): CrossChainDeps {
  return {
    readFee: async () => 207099407163124n,
    isValidKey: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    sourceBalance: async () => 10n ** 18n,
    prepare: async () => ({ multiChainRoot: "0x1234" as const, quoteChainIds: [11142220, 11155111], escrowed: 2800072018104900n, sourceFeeMax: 43918200000731970n, raw: {} }),
    sign: async () => "0xsig" as const,
    send: async () => "0xbundle",
    status: async () => ({ status: 200, receipts: [{ chainId: 11142220, transactionHash: "0xaaa" as const }, { chainId: 11155111, transactionHash: "0xbbb" as const }] }),
    sleep: async () => undefined,
    ...over,
  };
}

describe("CrossChainPanel", () => {
  test("shows the demo pricing banner and runs the flow to a verified result", async () => {
    const makeDeps = vi.fn(async () => deps());
    renderWith(fakeClient(), <CrossChainPanel makeDeps={makeDeps} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    expect(screen.getByRole("note")).toHaveTextContent("Demo pricing");
    await userEvent.click(screen.getByRole("button", { name: "Register through the relay" }));
    expect(await screen.findByText("Key valid in the Sepolia KeyStore")).toBeInTheDocument();
    expect(makeDeps).toHaveBeenCalledWith(expect.objectContaining({ walletKey: TEST_KEY, source: expect.objectContaining({ chainId: 11142220 }) }));
    expect(screen.getAllByText("done")).toHaveLength(7);
    expect(screen.getByText("0.0028", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /0xbbb/ })).toHaveAttribute("href", "https://sepolia.etherscan.io/tx/0xbbb");
  });

  test("surfaces a failed step", async () => {
    const makeDeps = vi.fn(async () => deps({ sourceBalance: async () => 0n }));
    renderWith(fakeClient(), <CrossChainPanel makeDeps={makeDeps} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.click(screen.getByRole("button", { name: "Register through the relay" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("holds nothing on the source chain");
    await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument());
  });

  test("source chain can be switched to Base Sepolia", async () => {
    const makeDeps = vi.fn(async () => deps());
    renderWith(fakeClient(), <CrossChainPanel makeDeps={makeDeps} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.selectOptions(screen.getByLabelText("Source chain"), "84532");
    await userEvent.click(screen.getByRole("button", { name: "Register through the relay" }));
    await waitFor(() => expect(makeDeps).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ chainId: 84532 }) })));
  });
});

describe("the relay's reason, not viem's wrapper", () => {
  test("a disabled interop service reads as the gate it is, not as a parameter error", async () => {
    // What the relay actually answers, wrapped the way viem delivers it: the
    // generic headline plus a kilobyte of echoed request. The panel used to
    // show the wrapper, so a known gate read as a broken bench (qa, 2026-10-05).
    const wrapped = new Error(
      "Invalid parameters were provided to the RPC method. Double check you have provided the correct " +
        `parameters. URL: https://testnet-relay.altana.network Request body: {"method":"wallet_prepareCalls"` +
        `,"params":[{"calls":[{"data":"0x${"ab".repeat(400)}"}]}]}`,
      {
        cause: {
          code: -32602,
          details: "multichain functionality is disabled: interop service not configured",
        },
      },
    );
    const makeDeps = vi.fn(async () => {
      throw wrapped;
    });
    renderWith(fakeClient(), <CrossChainPanel makeDeps={makeDeps} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await userEvent.click(screen.getByRole("button", { name: /Register through the relay/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/multichain functionality is disabled/);
    expect(alert).not.toHaveTextContent(/Invalid parameters were provided/);
    expect(alert.textContent ?? "").not.toMatch(/0xabab/);
  });

  test("no surface on the screen carries the echoed request, not just the alert", async () => {
    // The alert was the quiet surface. The loud ones are the step detail,
    // rendered under the failed step, and the activity log entry, and both
    // read from crossChain.ts's onStep detail rather than from the panel
    // (qa, 2026-10-05). Asserting the whole screen is what makes this a test
    // of the behaviour rather than of one element.
    const hex = `0x${"ab".repeat(400)}`;
    const wrapped = new Error(
      `Invalid parameters were provided to the RPC method. Request body: {"data":"${hex}"}`,
      { cause: { code: -32602, details: "multichain functionality is disabled: interop service not configured" } },
    );
    const makeDeps = vi.fn(async () => {
      throw wrapped;
    });
    const { container } = renderWith(fakeClient(), <CrossChainPanel makeDeps={makeDeps} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await userEvent.click(screen.getByRole("button", { name: /Register through the relay/ }));
    await screen.findByRole("alert");

    const onScreen = container.textContent ?? "";
    expect(onScreen).toContain("multichain functionality is disabled");
    expect(onScreen, "the echoed request must not reach any surface").not.toContain("0xabab");
    expect(onScreen).not.toContain("Invalid parameters were provided");
  });
});
