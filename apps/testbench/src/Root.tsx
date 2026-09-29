import { useMemo, useState } from "react";
import { App } from "./App";
import { chainsFor } from "./lib/chains";
import type { LogEntry } from "./lib/log";
import { createLiveClient } from "./lib/sdk";
import type { Settings } from "./lib/settings";
import { loadSettings, saveSettings, type Storage } from "./lib/storage";
import { AppProvider } from "./state/AppState";

/**
 * Holds the relay settings, because changing them rebuilds the SDK client: the
 * relay URL and the chain set are both fixed at `createClient` time. The wallet
 * and the stored sessions live in localStorage and survive the rebuild, so
 * switching relays keeps the wallet and swaps the relay under it.
 */
export function Root({ storage, env }: { storage: Storage; env: Record<string, string | undefined> }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings(storage, env));

  // Entries logged before the provider mounts are held and replayed, so the
  // first call after a relay switch is not lost from the activity log.
  const { client, attach } = useMemo(() => {
    let sink: ((e: LogEntry) => void) | undefined;
    const pending: LogEntry[] = [];
    const built = createLiveClient(chainsFor(settings, env), (e) => (sink ? sink(e) : pending.push(e)));
    return {
      client: built,
      attach: (fn: (e: LogEntry) => void) => {
        sink = fn;
        pending.splice(0).forEach(fn);
      },
    };
  }, [settings, env]);

  return (
    <AppProvider client={client} storage={storage}>
      <App
        attachLog={attach}
        settings={settings}
        onSettings={(next) => {
          setSettings(next);
          saveSettings(storage, next);
        }}
      />
    </AppProvider>
  );
}
