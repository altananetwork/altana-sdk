import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { AgentIdentityPanel } from "../../src/components/AgentIdentityPanel";
import { MirrorCard } from "../../src/components/MirrorCard";
import { PasskeyPanel } from "../../src/components/PasskeyPanel";
import { ProofPanel } from "../../src/components/ProofPanel";
import { SettingsPanel } from "../../src/components/SettingsPanel";
import { WalkthroughPanel } from "../../src/components/WalkthroughPanel";
import { X402Panel } from "../../src/components/X402Panel";
import { App, TABS } from "../../src/App";
import { defaultSettings } from "../../src/lib/settings";
import { CELO_SEPOLIA } from "@altananetwork/sdk";
import { TEST_ADDRESS, TEST_KEY, fakeClient } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

/* Brand Kit v2.0, on the rendered output rather than the source: tests/brand.test.ts
   lints the files, and this checks what a person actually sees. */

const KEY_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

const PANELS: { name: string; ui: ReactNode }[] = [
  { name: "Walkthrough", ui: <WalkthroughPanel /> },
  { name: "Passkey", ui: <PasskeyPanel /> },
  { name: "x402", ui: <X402Panel /> },
  { name: "Agent identity", ui: <AgentIdentityPanel /> },
  { name: "Proof", ui: <ProofPanel fetchImpl={(async () => new Response("{}", { status: 404 })) as never} /> },
  {
    name: "Settings",
    ui: <SettingsPanel settings={defaultSettings({})} onChange={() => {}} />,
  },
  {
    name: "Mirror card",
    ui: <MirrorCard chainId={CELO_SEPOLIA.chainId} target={{ user: TEST_ADDRESS, keyId: KEY_ID }} />,
  },
];

describe("the new panels follow the brand rules", () => {
  for (const { name, ui } of PANELS) {
    test(`${name}: no em dash reaches the screen`, () => {
      const { container } = renderWith(fakeClient(), ui, { v: 1, walletKey: TEST_KEY, sessions: [] });
      expect(container.textContent).not.toContain("—");
    });

    test(`${name}: at most one filled primary button`, () => {
      const { container } = renderWith(fakeClient(), ui, { v: 1, walletKey: TEST_KEY, sessions: [] });
      expect(container.querySelectorAll(".btn-primary").length).toBeLessThanOrEqual(1);
    });

    test(`${name}: every input and select has a label`, () => {
      const { container } = renderWith(fakeClient(), ui, { v: 1, walletKey: TEST_KEY, sessions: [] });
      const fields = container.querySelectorAll("input:not([type=radio]):not([type=checkbox]), select");
      for (const field of fields) {
        const id = field.getAttribute("id");
        const labelled =
          (id && container.querySelector(`label[for="${id}"]`)) ??
          field.getAttribute("aria-label") ??
          field.closest("label");
        expect(labelled, `${name}: unlabelled field ${field.outerHTML.slice(0, 80)}`).toBeTruthy();
      }
    });
  }
});

describe("the tab set", () => {
  test("leads with the walkthrough, which is the showcase screen", () => {
    expect(TABS[0]).toEqual({ id: "walkthrough", label: "Walkthrough" });
  });

  test("every tab renders its panel without throwing", async () => {
    for (const tab of TABS) {
      const { unmount } = renderWith(
        fakeClient(),
        <App initialTab={tab.id} settings={defaultSettings({})} onSettings={vi.fn()} />,
        { v: 1, walletKey: TEST_KEY, sessions: [] },
      );
      const section = screen.getByRole("region", { name: tab.label });
      expect(within(section).getByRole("heading", { level: 2 })).toBeInTheDocument();
      unmount();
    }
  });
});
