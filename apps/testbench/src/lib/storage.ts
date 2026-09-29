import type { SerializedSession, SessionLeg } from "@altananetwork/sdk";
import type { Hex } from "viem";
import { defaultSettings, migrateSettings, type Settings } from "./settings";

export const STORAGE_KEY = "altana.testbench.v1";
export const SETTINGS_KEY = "altana.testbench.settings.v1";

export type StoredSession = {
  id: string;
  name: string;
  serialized: SerializedSession;
  sessionKey: Hex;
  keyId: Hex;
  legs: SessionLeg[];
  createdAt: number;
  revokedAt?: number;
  /** Absent on entries saved before this field existed: granted. */
  status?: "granting" | "granted" | "failed";
};

export type StoredState = {
  v: 1;
  walletKey?: Hex;
  /** Set once the key was registered with the relay the page is pointed at. */
  registered?: boolean;
  chainId?: number;
  sessions: StoredSession[];
};

export const EMPTY_STATE: StoredState = { v: 1, sessions: [] };

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Accepts any earlier or malformed shape and returns a valid v1 state. */
export function migrate(raw: unknown): StoredState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE, sessions: [] };
  const r = raw as Record<string, unknown>;
  const walletKey = typeof r.walletKey === "string" && HEX_KEY.test(r.walletKey) ? (r.walletKey as Hex) : undefined;
  const chainId = typeof r.chainId === "number" && Number.isInteger(r.chainId) ? r.chainId : undefined;
  const sessions = Array.isArray(r.sessions)
    ? (r.sessions.filter(isStoredSession) as StoredSession[])
    : [];
  const registered = r.registered === true;
  return { v: 1, ...(walletKey ? { walletKey } : {}), ...(registered ? { registered } : {}), ...(chainId ? { chainId } : {}), sessions };
}

function isStoredSession(s: unknown): s is StoredSession {
  if (!s || typeof s !== "object") return false;
  const x = s as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    typeof x.sessionKey === "string" &&
    HEX_KEY.test(x.sessionKey) &&
    typeof x.serialized === "object" &&
    x.serialized !== null &&
    typeof x.keyId === "string" &&
    Array.isArray(x.legs)
  );
}

export type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export function load(storage: Storage): StoredState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return migrate(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...EMPTY_STATE, sessions: [] };
  }
}

export function save(storage: Storage, state: StoredState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clear(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}

export function loadSettings(storage: Storage, env: Record<string, string | undefined>): Settings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    return migrateSettings(raw ? JSON.parse(raw) : null, env);
  } catch {
    return defaultSettings(env);
  }
}

export function saveSettings(storage: Storage, settings: Settings): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function isPrivateKey(value: string): value is Hex {
  return HEX_KEY.test(value.trim());
}
