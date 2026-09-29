import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA } from "@altananetwork/sdk";
import { AgentIdentityPanel } from "../../src/components/AgentIdentityPanel";
import { TEST_ADDRESS, TEST_KEY, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const CARD = {
  name: "Altana Wallet Agent",
  description: "Agentic wallets on Celo",
  version: "1.0.0",
  skills: [{ id: "pay-gas", name: "Pay gas in a chosen token", description: "CELO, USDC, USDm, EURm or KESm" }],
  registrations: [{ agentId: 449, agentRegistry: "eip155:11142220:0x8004A818" }],
};
const DATA_URI = `data:application/json;base64,${btoa(JSON.stringify(CARD))}`;

describe("AgentIdentityPanel", () => {
  test("reads the Altana agent on load and renders its record", async () => {
    const client = fakeClient({
      getErc8004Agent: vi.fn(async () => ({ owner: TEST_ADDRESS, agentUri: DATA_URI })),
    });
    renderWith(client, <AgentIdentityPanel />, { v: 1, sessions: [] });

    await waitFor(() =>
      expect(client.getErc8004Agent).toHaveBeenCalledWith({ chainId: CELO_SEPOLIA.chainId, agentId: 449n }),
    );
    expect(await screen.findByRole("heading", { name: "Altana Wallet Agent" })).toBeInTheDocument();
    expect(screen.getByText("Pay gas in a chosen token")).toBeInTheDocument();
    expect(screen.getByText(/names agent 449 on this registry/)).toBeInTheDocument();
  });

  test("says identity works on Celo and hiring does not", async () => {
    renderWith(fakeClient({ getErc8004Agent: vi.fn(async () => ({ owner: TEST_ADDRESS, agentUri: DATA_URI })) }), <AgentIdentityPanel />, { v: 1, sessions: [] });
    expect(screen.getByText(/cannot be hired here/)).toBeInTheDocument();
  });

  test("an unreadable record does not make the identity look broken", async () => {
    const client = fakeClient({
      getErc8004Agent: vi.fn(async () => ({
        owner: TEST_ADDRESS,
        agentUri: "https://docs.altana.network/.well-known/agent-card.json",
      })),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    renderWith(client, <AgentIdentityPanel />, { v: 1, sessions: [] });
    expect(await screen.findByText(/The identity itself is on chain and unaffected/)).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  test("a registry read that fails shows its own words", async () => {
    const client = fakeClient({
      getErc8004Agent: vi.fn(async () => {
        throw new Error("erc8004: no identity registry registered for chainId 84532");
      }),
    });
    renderWith(client, <AgentIdentityPanel />, { v: 1, sessions: [] });
    expect(await screen.findByRole("alert")).toHaveTextContent(/no identity registry registered/);
  });

  test("minting is off until there is a wallet", async () => {
    renderWith(fakeClient({ getErc8004Agent: vi.fn(async () => ({ owner: TEST_ADDRESS, agentUri: DATA_URI })) }), <AgentIdentityPanel />, { v: 1, sessions: [] });
    expect(screen.getByRole("button", { name: "Mint an identity" })).toBeDisabled();
    expect(screen.getByText("Create a wallet first.")).toBeInTheDocument();
  });

  test("minting sends the typed record and then reads the id back", async () => {
    const client = fakeClient({
      getErc8004Agent: vi.fn(async () => ({ owner: TEST_ADDRESS, agentUri: DATA_URI })),
      registerErc8004Agent: vi.fn(async () => ({
        agentId: 450n,
        status: "CONFIRMED",
        transactionHash: "0xmint" as const,
      })),
    });
    renderWith(client, <AgentIdentityPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });

    const nameField = screen.getByLabelText("Name");
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "Demo agent");
    await userEvent.click(screen.getByRole("button", { name: "Mint an identity" }));

    await waitFor(() => expect(client.registerErc8004Agent).toHaveBeenCalled());
    const sent = vi.mocked(client.registerErc8004Agent).mock.calls[0]![0];
    expect(sent.chainId).toBe(CELO_SEPOLIA.chainId);
    expect(JSON.parse(atob(sent.agentUri.split(",")[1]!))).toMatchObject({
      name: "Demo agent",
      registrations: [],
    });
    expect(await screen.findByText("Agent 450")).toBeInTheDocument();
    // And it read the new id back from the registry.
    await waitFor(() =>
      expect(client.getErc8004Agent).toHaveBeenCalledWith({ chainId: CELO_SEPOLIA.chainId, agentId: 450n }),
    );
  });

  test("a failed mint is reported, and no agent is claimed", async () => {
    const client = fakeClient({
      getErc8004Agent: vi.fn(async () => ({ owner: TEST_ADDRESS, agentUri: DATA_URI })),
      registerErc8004Agent: vi.fn(async () => {
        throw new Error("the relay rejected the request: intent reverted");
      }),
    });
    renderWith(client, <AgentIdentityPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.click(screen.getByRole("button", { name: "Mint an identity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/intent reverted/);
    expect(screen.queryByText(/^Agent \d+$/)).not.toBeInTheDocument();
  });
});
