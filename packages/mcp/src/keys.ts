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
 *
 * ## Keeping a test run out of somebody's real keychain
 *
 * `ALTANA_KEY_STORE=file:<path>` writes and reads keys at `<path>` instead of
 * the OS keychain. It exists for automation: an end-to-end test that imported a
 * session into the developer's actual login keychain would leave real entries
 * behind, and on macOS it can also raise an access prompt that no unattended run
 * can answer.
 *
 * It is not a hardening feature and must not be used in production: a file holds
 * keys in plain text, where the keychain encrypts them at rest. Unset, nothing
 * changes and the keychain is used exactly as before.
 *
 * `ALTANA_HOME` moves `~/.altana` as well, for the same reason.
 */

import { Entry, findCredentials } from "@napi-rs/keyring";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { privateKeyToAccount } from "viem/accounts";
import { heldSessionKey } from "./memorySessions.js";
import type { Address, Hex } from "viem";

const SERVICE_WALLET = "altana-wallet";
const SERVICE_SESSION = "altana-session";

/** Where `~/.altana` lives. Overridable so a test run keeps out of a real one. */
export function altanaHome(): string {
  const override = process.env.ALTANA_HOME?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".altana");
}

/**
 * The file a test run writes keys to, or undefined for the OS keychain.
 *
 * Read on every call rather than captured once, so a test can set it before
 * importing anything and a single process can be pointed at different stores.
 */
function keyFileOverride(): string | undefined {
  const raw = process.env.ALTANA_KEY_STORE?.trim();
  if (!raw) return undefined;
  if (!raw.startsWith("file:")) {
    throw new Error(
      `ALTANA_KEY_STORE must look like file:/path/to/keys.json, got "${raw}".`,
    );
  }
  const path = raw.slice("file:".length).trim();
  if (!path) throw new Error("ALTANA_KEY_STORE is file: with no path after it.");
  return path;
}

type KeyFile = {
  wallets?: { name: string; privateKey: Hex }[];
  sessions?: { name: string; privateKey: Hex }[];
};

async function readKeyFile(path: string): Promise<KeyFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as KeyFile;
  } catch {
    return {};
  }
}

async function writeKeyFile(path: string, data: KeyFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

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
  // A session key handed to this process at startup never touches the keychain
  // or the disk, so it has to be found here or not at all.
  if (kind === "session") {
    const inMemory = heldSessionKey(name);
    if (inMemory) {
      return {
        name,
        address: privateKeyToAccount(inMemory).address,
        privateKey: inMemory,
        source: "env",
      };
    }
  }

  // With an override in place the keychain is never consulted, so a test run
  // cannot accidentally read a real entry of the same name either.
  if (keyFileOverride()) {
    const file = await tryFile(kind, name);
    if (file) return file;
    const env = tryEnv(kind, name);
    if (env) return env;
    throw new Error(
      `No ${kind} key named "${name}" in ${keyFileOverride()} or env var ` +
        `${envPrefixFor(kind)}${envName(name)}_PRIVATE_KEY.`,
    );
  }
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
  const file = keyFileOverride();
  if (file) {
    const bucket = fileBucketFor(kind);
    const data = await readKeyFile(file);
    const existing = (data[bucket] ?? []).filter((k) => k.name !== name);
    await writeKeyFile(file, { ...data, [bucket]: [...existing, { name, privateKey }] });
    return;
  }
  const entry = new Entry(serviceFor(kind), name);
  entry.setPassword(privateKey);
}

async function deleteKey(kind: KeyKind, name: string): Promise<void> {
  const file = keyFileOverride();
  if (file) {
    const bucket = fileBucketFor(kind);
    const data = await readKeyFile(file);
    await writeKeyFile(file, {
      ...data,
      [bucket]: (data[bucket] ?? []).filter((k) => k.name !== name),
    });
    return;
  }
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
  const path = join(altanaHome(), "keys.json");
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
