/**
 * Which relay the bench talks to, and which chains it configures.
 *
 * Both are runtime settings rather than build-time env, because the demo is
 * walked against three different relays in one sitting and they do not serve
 * the same chains:
 *
 * - Railway (the live testnet relay) serves Celo Sepolia, Base Sepolia and
 *   Ethereum Sepolia.
 * - infra's local relay staging (mode A) serves **Celo Sepolia only**.
 * - infra's anvil forks (mode B) serve Celo Sepolia and Ethereum Sepolia.
 *
 * Configuring a chain the relay does not serve is not harmless: qa's baseline
 * pass hit `Cannot destructure property 'contracts' of '[intermediate value]'`
 * on `createWallet` against mode A, which names neither the chain nor the
 * relay (evidence/2026-09-28-testbench-baseline.md, finding 1). So the chain
 * set travels with the relay choice.
 */

import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA, TESTNET_RELAY_URL } from "@altananetwork/sdk";

export type RelayPresetId = "railway" | "local" | "fork" | "custom";

export type RelayPreset = {
  id: RelayPresetId;
  label: string;
  /** Undefined for "custom": the URL comes from the settings. */
  url?: string;
  /** Where the chain selection starts before the relay answers for itself. */
  chainIds: number[];
  note: string;
};

/**
 * The chain list on each preset is a **starting point only**: the panel asks
 * the relay what it serves and uses the answer. A hardcoded list went stale
 * within a day, and the walkthrough then skipped the milestone's headline
 * claim because the preset said Celo only (qa, 2026-09-29).
 */
export const RELAY_PRESETS: readonly RelayPreset[] = [
  {
    id: "railway",
    label: "Testnet relay",
    url: TESTNET_RELAY_URL,
    chainIds: [CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId, SEPOLIA.chainId],
    note: "The live relay. Fee currencies other than CELO need the staging promotion (G1).",
  },
  {
    id: "local",
    label: "Local relay staging",
    url: "http://127.0.0.1:19129",
    chainIds: [CELO_SEPOLIA.chainId],
    note: "Relay staging against live Celo Sepolia. Which chains it serves is asked of it, since infra changes them.",
  },
  {
    id: "fork",
    label: "Local forks",
    url: "http://127.0.0.1:19139",
    chainIds: [CELO_SEPOLIA.chainId, SEPOLIA.chainId],
    note: "Anvil forks of both chains with interop on. Transactions here are not public and no explorer can show them.",
  },
  {
    id: "custom",
    label: "Custom",
    chainIds: [CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId, SEPOLIA.chainId],
    note: "Any other relay. Choose the chains it serves yourself.",
  },
];

export const ALL_CHAIN_IDS = [CELO_SEPOLIA.chainId, BASE_SEPOLIA.chainId, SEPOLIA.chainId] as const;

export type Settings = {
  preset: RelayPresetId;
  /** Only read when `preset` is "custom". */
  customUrl: string;
  chainIds: number[];
};

export function presetById(id: RelayPresetId): RelayPreset {
  return RELAY_PRESETS.find((p) => p.id === id) ?? RELAY_PRESETS[0]!;
}

/** The relay URL the settings resolve to, or undefined when custom is blank. */
export function relayUrlOf(settings: Settings): string | undefined {
  const url = settings.preset === "custom" ? settings.customUrl.trim() : presetById(settings.preset).url;
  return url ? url.replace(/\/$/, "") : undefined;
}

/**
 * The settings a fresh page starts with. `VITE_RELAY_URL` still wins when it is
 * set, so the env override documented in the README keeps working; it selects
 * the matching preset when it names one, and "custom" otherwise.
 */
export function defaultSettings(env: Record<string, string | undefined>): Settings {
  const fromEnv = env.VITE_RELAY_URL?.trim().replace(/\/$/, "");
  if (fromEnv) {
    const match = RELAY_PRESETS.find((p) => p.url?.replace(/\/$/, "") === fromEnv);
    if (match) return { preset: match.id, customUrl: "", chainIds: [...match.chainIds] };
    return { preset: "custom", customUrl: fromEnv, chainIds: [...ALL_CHAIN_IDS] };
  }
  const railway = presetById("railway");
  return { preset: "railway", customUrl: "", chainIds: [...railway.chainIds] };
}

/** Accepts anything and returns settings that will not break the client. */
export function migrateSettings(raw: unknown, env: Record<string, string | undefined>): Settings {
  const fallback = defaultSettings(env);
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const preset = RELAY_PRESETS.some((p) => p.id === r.preset) ? (r.preset as RelayPresetId) : fallback.preset;
  const customUrl = typeof r.customUrl === "string" ? r.customUrl : "";
  const chainIds = Array.isArray(r.chainIds)
    ? r.chainIds.filter((c): c is number => typeof c === "number" && ALL_CHAIN_IDS.includes(c as never))
    : [];
  return {
    preset,
    customUrl,
    chainIds: chainIds.length > 0 ? chainIds : [...presetById(preset).chainIds],
  };
}
