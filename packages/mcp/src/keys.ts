/**
 * Key resolution for the Altana MCP server.
 *
 * Wallet admin keys and session keys live in SEPARATE namespaces so a
 * session can never collide with — and overwrite — an admin entry.
 *
 *   Wallet admins:  OS keychain service "altana-wallet"
 *                   File   ~/.altana/keys.json → `wallets[]`
 *                   Env    ALTANA_WALLET_<NAME>_PRIVATE_KEY
 *
 *   Session keys:   OS keychain service "altana-session"
 *                   File   ~/.altana/keys.json → `sessions[]`
 *                   Env    ALTANA_SESSION_<NAME>_PRIVATE_KEY
 *
 * Resolution order within a kind: keychain → file → env. The kind is
 * always supplied by the caller; there is no generic "find this name
 * anywhere" entry point on purpose.
 *
 * Writing happens through this module (setWalletKey / setSessionKey),
 * which guards against overwrite by checking existence first at the
 * callsite. The server only reads existing keys for signing — the
 * `altana-keys` CLI is responsible for offline imports.
 */

import { Entry, findCredentials } from "@napi-rs/keyring";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const SERVICE_WALLET = "altana-wallet";
const SERVICE_SESSION = "altana-session";

export type KeyKind = "wallet" | "session";
export type KeySource = "keychain" | "file" | "env";

export type ResolvedKey = {
  name: string;
  address: Address;
  privateKey: Hex;
  source: KeySource;
};

export type ListedKey = {
  name: string;
  address: Address;
  source: KeySource;
};

// ---------- Wallet (admin) key API ----------------------------------------

export const getWalletKey = (name: string) => getKey("wallet", name);
export const setWalletKey = (name: string, pk: Hex) => setKey("wallet", name, pk);
export const deleteWalletKey = (name: string) => deleteKey("wallet", name);
export const walletKeyExists = (name: string) => keyExists("wallet", name);
export const listWalletKeys = () => listKeysByKind("wallet");

// ---------- Session key API -----------------------------------------------

export const getSessionKey = (name: string) => getKey("session", name);
export const setSessionKey = (name: string, pk: Hex) => setKey("session", name, pk);
export const deleteSessionKey = (name: string) => deleteKey("session", name);
export const sessionKeyExists = (name: string) => keyExists("session", name);
export const listSessionKeys = () => listKeysByKind("session");

// ---------- Internals (kind-parameterized) --------------------------------

function serviceFor(kind: KeyKind): string {
  return kind === "wallet" ? SERVICE_WALLET : SERVICE_SESSION;
}

function envPrefixFor(kind: KeyKind): string {
  return kind === "wallet" ? "ALTANA_WALLET_" : "ALTANA_SESSION_";
}

function fileBucketFor(kind: KeyKind): "wallets" | "sessions" {
  return kind === "wallet" ? "wallets" : "sessions";
}

async function getKey(kind: KeyKind, name: string): Promise<ResolvedKey> {
  const kc = await tryKeychain(kind, name);
  if (kc) return kc;
  const file = await tryFile(kind, name);
  if (file) return file;
  const env = tryEnv(kind, name);
  if (env) return env;
  const prefix = envPrefixFor(kind);
  throw new Error(
    `No ${kind} key named "${name}" found in OS keychain (service: ` +
      `${serviceFor(kind)}), ~/.altana/keys.json, or env var ` +
      `${prefix}${envName(name)}_PRIVATE_KEY.`,
  );
}

async function setKey(kind: KeyKind, name: string, privateKey: Hex): Promise<void> {
  const entry = new Entry(serviceFor(kind), name);
  entry.setPassword(privateKey);
}

async function deleteKey(kind: KeyKind, name: string): Promise<void> {
  try {
    const entry = new Entry(serviceFor(kind), name);
    entry.deleteCredential();
  } catch {
    // Already gone — that's fine.
  }
}

async function keyExists(kind: KeyKind, name: string): Promise<boolean> {
  try {
    await getKey(kind, name);
    return true;
  } catch {
    return false;
  }
}

async function listKeysByKind(kind: KeyKind): Promise<ListedKey[]> {
  const out: ListedKey[] = [];
  const seen = new Set<string>();
  const service = serviceFor(kind);

  // Keychain
  try {
    const creds = findCredentials(service);
    for (const { account, password } of creds) {
      if (seen.has(account)) continue;
      const address = privateKeyToAccount(password as Hex).address;
      out.push({ name: account, address, source: "keychain" });
      seen.add(account);
    }
  } catch {
    /* keychain unavailable, ignore */
  }

  // File
  try {
    const entries = await readFileKeys(kind);
    for (const w of entries) {
      if (seen.has(w.name)) continue;
      const address = privateKeyToAccount(w.privateKey).address;
      out.push({ name: w.name, address, source: "file" });
      seen.add(w.name);
    }
  } catch {
    /* file missing, ignore */
  }

  // Env
  const prefix = envPrefixFor(kind);
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !key.endsWith("_PRIVATE_KEY") || !val) {
      continue;
    }
    const raw = key.slice(prefix.length, -"_PRIVATE_KEY".length);
    const name = raw.toLowerCase();
    if (seen.has(name)) continue;
    try {
      const address = privateKeyToAccount(val as Hex).address;
      out.push({ name, address, source: "env" });
      seen.add(name);
    } catch {
      /* not a valid key, skip */
    }
  }

  return out;
}

async function tryKeychain(kind: KeyKind, name: string): Promise<ResolvedKey | null> {
  try {
    const entry = new Entry(serviceFor(kind), name);
    const pk = entry.getPassword();
    if (!pk) return null;
    const address = privateKeyToAccount(pk as Hex).address;
    return { name, address, privateKey: pk as Hex, source: "keychain" };
  } catch {
    return null;
  }
}

async function tryFile(kind: KeyKind, name: string): Promise<ResolvedKey | null> {
  try {
    const entries = await readFileKeys(kind);
    const w = entries.find((x) => x.name === name);
    if (!w) return null;
    const address = privateKeyToAccount(w.privateKey).address;
    return { name, address, privateKey: w.privateKey, source: "file" };
  } catch {
    return null;
  }
}

function tryEnv(kind: KeyKind, name: string): ResolvedKey | null {
  const pk = process.env[`${envPrefixFor(kind)}${envName(name)}_PRIVATE_KEY`];
  if (!pk) return null;
  try {
    const address = privateKeyToAccount(pk as Hex).address;
    return { name, address, privateKey: pk as Hex, source: "env" };
  } catch {
    return null;
  }
}

type FileKey = { name: string; privateKey: Hex };

async function readFileKeys(kind: KeyKind): Promise<FileKey[]> {
  const path = join(homedir(), ".altana", "keys.json");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as {
    wallets?: FileKey[];
    sessions?: FileKey[];
  };
  return parsed[fileBucketFor(kind)] ?? [];
}

function envName(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}
