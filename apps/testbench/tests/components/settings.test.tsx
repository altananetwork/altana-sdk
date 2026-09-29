import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { defaultSettings, type Settings } from "../../src/lib/settings";
import { fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

function setup(settings: Settings = defaultSettings({})) {
  const onChange = vi.fn();
  renderWith(fakeClient(), <SettingsPanel settings={settings} onChange={onChange} />);
  return { onChange };
}

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

  test("a chain the chosen relay does not serve is marked as such", () => {
    setup({ preset: "local", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] });
    const base = screen.getByRole("checkbox", { name: /Base Sepolia/ });
    expect(base).not.toBeChecked();
    expect(screen.getAllByText(/not served by Local relay staging/).length).toBe(2);
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
