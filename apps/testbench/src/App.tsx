import { useEffect, useState } from "react";
import { ActivityLogPanel } from "./components/ActivityLogPanel";
import { AgentIdentityPanel } from "./components/AgentIdentityPanel";
import { CrossChainPanel } from "./components/CrossChainPanel";
import { FeeTokensPanel } from "./components/FeeTokensPanel";
import { SendPanel } from "./components/SendPanel";
import { MirrorPanel } from "./components/MirrorPanel";
import { PasskeyPanel } from "./components/PasskeyPanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { ProofPanel } from "./components/ProofPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { X402Panel } from "./components/X402Panel";
import { WalkthroughPanel } from "./components/WalkthroughPanel";
import { WalletPanel } from "./components/WalletPanel";
import type { LogEntry } from "./lib/log";
import { defaultSettings, type Settings } from "./lib/settings";
import { useApp } from "./state/AppState";

export type Tab =
  | "walkthrough"
  | "wallet"
  | "passkey"
  | "fees"
  | "send"
  | "sessions"
  | "mirror"
  | "crosschain"
  | "x402"
  | "identity"
  | "proof"
  | "settings";

export const TABS: { id: Tab; label: string }[] = [
  { id: "walkthrough", label: "Walkthrough" },
  { id: "wallet", label: "Wallet" },
  { id: "passkey", label: "Passkey" },
  { id: "fees", label: "Fee tokens" },
  { id: "send", label: "Send" },
  { id: "sessions", label: "Sessions" },
  { id: "mirror", label: "Celo mirror" },
  { id: "crosschain", label: "Cross-chain" },
  { id: "x402", label: "x402" },
  { id: "identity", label: "Agent identity" },
  { id: "proof", label: "Proof" },
  { id: "settings", label: "Settings" },
];

export type AppProps = {
  attachLog?: (fn: (e: LogEntry) => void) => void;
  settings?: Settings;
  onSettings?: (next: Settings) => void;
  initialTab?: Tab;
};

export function App({ attachLog, settings, onSettings, initialTab = "walkthrough" }: AppProps) {
  const { dispatch } = useApp();
  const [tab, setTab] = useState<Tab>(initialTab);
  const activeSettings = settings ?? defaultSettings({});
  useEffect(() => {
    attachLog?.((e) => dispatch({ type: "log/add", entry: e }));
  }, [attachLog, dispatch]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo-dark" src="/altana-logo-dark.svg" alt="Altana" />
          <img className="logo-white" src="/altana-logo-white.svg" alt="" aria-hidden="true" />
          <h1>Test bench</h1>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${tab === t.id ? " active" : ""}`}
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="main">
        <section aria-label={TABS.find((t) => t.id === tab)?.label}>
          {tab === "walkthrough" && <WalkthroughPanel />}
          {tab === "wallet" && <WalletPanel />}
          {tab === "passkey" && <PasskeyPanel />}
          {tab === "fees" && <FeeTokensPanel />}
          {tab === "send" && <SendPanel />}
          {tab === "sessions" && <SessionsPanel />}
          {tab === "mirror" && <MirrorPanel />}
          {tab === "crosschain" && <CrossChainPanel />}
          {tab === "x402" && <X402Panel />}
          {tab === "identity" && <AgentIdentityPanel />}
          {tab === "proof" && <ProofPanel />}
          {tab === "settings" && (
            <SettingsPanel settings={activeSettings} onChange={(next) => onSettings?.(next)} />
          )}
        </section>
        <aside aria-label="Activity log">
          <ActivityLogPanel />
        </aside>
      </main>
    </div>
  );
}
