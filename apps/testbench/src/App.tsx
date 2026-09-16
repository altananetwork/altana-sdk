import { useEffect, useState } from "react";
import { ActivityLogPanel } from "./components/ActivityLogPanel";
import { FeeTokensPanel } from "./components/FeeTokensPanel";
import { SendPanel } from "./components/SendPanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { WalletPanel } from "./components/WalletPanel";
import type { LogEntry } from "./lib/log";
import { useApp } from "./state/AppState";

export type Tab = "wallet" | "fees" | "send" | "sessions" | "crosschain";

export const TABS: { id: Tab; label: string }[] = [
  { id: "wallet", label: "Wallet" },
  { id: "fees", label: "Fee tokens" },
  { id: "send", label: "Send" },
  { id: "sessions", label: "Sessions" },
  { id: "crosschain", label: "Cross-chain" },
];

export function App({ attachLog }: { attachLog?: (fn: (e: LogEntry) => void) => void }) {
  const { dispatch } = useApp();
  const [tab, setTab] = useState<Tab>("wallet");
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
          {tab === "wallet" && <WalletPanel />}
          {tab === "fees" && <FeeTokensPanel />}
          {tab === "send" && <SendPanel />}
          {tab === "sessions" && <SessionsPanel />}
          {tab === "crosschain" && (
            <div className="panel">
              <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
              <p className="lead">Coming in a later phase.</p>
            </div>
          )}
        </section>
        <aside aria-label="Activity log">
          <ActivityLogPanel />
        </aside>
      </main>
    </div>
  );
}
