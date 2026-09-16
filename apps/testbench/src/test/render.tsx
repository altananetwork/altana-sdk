import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TestbenchClient } from "../lib/sdk";
import { STORAGE_KEY, type StoredState } from "../lib/storage";
import { AppProvider } from "../state/AppState";

export function memoryStorage(initial?: StoredState) {
  const map = new Map<string, string>();
  if (initial) map.set(STORAGE_KEY, JSON.stringify(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => (map.get(STORAGE_KEY) ? (JSON.parse(map.get(STORAGE_KEY)!) as StoredState) : undefined),
  };
}

export function renderWith(client: TestbenchClient, ui: ReactNode, initial?: StoredState) {
  const storage = memoryStorage(initial);
  const result = render(
    <AppProvider client={client} storage={storage}>
      {ui}
    </AppProvider>,
  );
  return { ...result, storage };
}
