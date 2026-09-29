import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { defaultSettings, type Settings } from "../../src/lib/settings";
import { fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

/** No relay answers by default, so a test opts into a probe result. */
function setup(settings: Settings = defaultSettings({}), probe?: ReturnType<typeof vi.fn>) {
  const onChange = vi.fn();
  const probeFn = probe ?? vi.fn(async () => ({ status: "unreachable" as const, reason: "not asked" }));
  renderWith(
    fakeClient(),
    <SettingsPanel settings={settings} onChange={onChange} probe={probeFn as never} />,
  );
  return { onChange, probe: probeFn };
}

const serving = (...chainIds: number[]) => vi.fn(async () => ({ status: "serving" as const, chainIds }));

describe("SettingsPanel", () => {
  test("picking a relay also sets the chains that relay serves", async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole("radio", { name: /Local relay staging/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "local", chainIds: [CELO_SEPOLIA.chainId] }),
    );
  });

  test("the forks preset takes Celo and Ethereum Sepolia, and says its transactions are not public", async () => {
    const { onChange } = setup();
    expect(screen.getByText(/not public and no explorer can show them/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Local forks/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ chainIds: [CELO_SEPOLIA.chainId, SEPOLIA.chainId] }),
    );
  });

  test("without an answer from the relay, the preset's list is shown as the preset's", async () => {
    setup({ preset: "local", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] });
    expect(await screen.findByText("no answer")).toBeInTheDocument();
    expect(screen.getByText(/the list below is the preset's, which can be out of date/)).toBeInTheDocument();
    expect(screen.getAllByText(/not in the Local relay staging preset/).length).toBe(2);
  });

  test("the relay's own answer replaces the preset's list", async () => {
    // qa hit this: infra added Ethereum Sepolia to the local relay, the preset
    // still said Celo only, and the walkthrough skipped the milestone claim.
    const { onChange, probe } = setup(
      { preset: "local", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] },
      serving(CELO_SEPOLIA.chainId, SEPOLIA.chainId),
    );
    await waitFor(() => expect(probe).toHaveBeenCalledWith("http://127.0.0.1:19129"));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ chainIds: [CELO_SEPOLIA.chainId, SEPOLIA.chainId] }),
      ),
    );
    expect(await screen.findByText("answered by the relay")).toBeInTheDocument();
  });

  test("a chain the relay says it does not serve is marked from the answer, not the preset", async () => {
    setup(
      { preset: "railway", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] },
      serving(CELO_SEPOLIA.chainId),
    );
    // Base Sepolia and Sepolia: two chains the bench knows and this relay does not serve.
    expect((await screen.findAllByText(/this relay does not serve it/)).length).toBe(2);
  });

  test("chains the relay serves but the bench cannot configure are named, not silently dropped", async () => {
    setup({ preset: "railway", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] }, serving(CELO_SEPOLIA.chainId, 97));
    expect(await screen.findByText(/also serves 97, which the bench has no configuration for/)).toBeInTheDocument();
  });

  test("a selection that disagrees with the relay offers a one-click fix", async () => {
    const { onChange } = setup(
      { preset: "custom", customUrl: "http://relay.example", chainIds: [CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId] },
      serving(CELO_SEPOLIA.chainId, SEPOLIA.chainId),
    );
    // The first application is automatic; untick one and the banner returns.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const fix = await screen.findByRole("button", { name: "Use the chains this relay serves" });
    await userEvent.click(fix);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ chainIds: [CELO_SEPOLIA.chainId, SEPOLIA.chainId] }),
    );
  });

  test("a chain can be ticked on or off by hand", async () => {
    const { onChange } = setup({ preset: "local", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] });
    await userEvent.click(screen.getByRole("checkbox", { name: /Base Sepolia/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ chainIds: [CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId] }),
    );
  });

  test("custom shows a URL field, and an empty one is called out", async () => {
    const { onChange } = setup({ preset: "custom", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] });
    expect(screen.getByLabelText("Relay URL")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot reach a relay until one is set/);
    await userEvent.type(screen.getByLabelText("Relay URL"), "h");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ customUrl: "h" }));
  });

  test("no chains at all is called out rather than silently breaking the client", () => {
    setup({ preset: "railway", customUrl: "", chainIds: [] });
    expect(screen.getByRole("alert")).toHaveTextContent(/Pick at least one chain/);
  });
});
