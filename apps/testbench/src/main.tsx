import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/components.css";
import { App } from "./App";
import { chainsFromEnv } from "./lib/chains";
import { createLiveClient } from "./lib/sdk";
import { AppProvider } from "./state/AppState";
import type { LogEntry } from "./lib/log";

const chains = chainsFromEnv(import.meta.env as Record<string, string | undefined>);

// The log sink is wired after the provider mounts; entries before that are kept.
const pending: LogEntry[] = [];
let sink: ((e: LogEntry) => void) | undefined;
const client = createLiveClient(chains, (e) => (sink ? sink(e) : pending.push(e)));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider client={client} storage={window.localStorage}>
      <App
        attachLog={(fn) => {
          sink = fn;
          pending.splice(0).forEach(fn);
        }}
      />
    </AppProvider>
  </StrictMode>,
);
