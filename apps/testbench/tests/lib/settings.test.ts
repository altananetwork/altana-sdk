import { describe, expect, test } from "vitest";
import { BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA, TESTNET_RELAY_URL } from "@altananetwork/sdk";
import { applyEnv, chainsFor } from "../../src/lib/chains";
import {
  defaultSettings,
  migrateSettings,
  presetById,
  relayUrlOf,
  RELAY_PRESETS,
  type Settings,
} from "../../src/lib/settings";

const LOCAL = "http://127.0.0.1:19129";
const FORK = "http://127.0.0.1:19139";

describe("relay presets", () => {
  test("each preset names only the chains that relay serves", () => {
    expect(presetById("local").chainIds).toEqual([CELO_SEPOLIA.chainId]);
    expect(presetById("fork").chainIds).toEqual([CELO_SEPOLIA.chainId, SEPOLIA.chainId]);
    expect(presetById("railway").chainIds).toContain(BASE_SEPOLIA.chainId);
  });

  test("a trailing slash never reaches the client", () => {
    expect(relayUrlOf({ preset: "custom", customUrl: `${LOCAL}/`, chainIds: [] })).toBe(LOCAL);
  });

  test("a blank custom URL resolves to nothing rather than an empty string", () => {
    expect(relayUrlOf({ preset: "custom", customUrl: "   ", chainIds: [] })).toBeUndefined();
  });

  test("an unknown preset falls back to the first rather than crashing", () => {
    expect(presetById("nope" as never).id).toBe(RELAY_PRESETS[0]!.id);
  });
});

describe("defaultSettings", () => {
  test("with no env it is the live testnet relay and all three chains", () => {
    const s = defaultSettings({});
    expect(s.preset).toBe("railway");
    expect(relayUrlOf(s)).toBe(TESTNET_RELAY_URL.replace(/\/$/, ""));
    expect(s.chainIds).toHaveLength(3);
  });

  test("VITE_RELAY_URL naming a known relay selects that preset and its chains", () => {
    const s = defaultSettings({ VITE_RELAY_URL: LOCAL });
    expect(s.preset).toBe("local");
    expect(s.chainIds).toEqual([CELO_SEPOLIA.chainId]);
  });

  test("VITE_RELAY_URL naming an unknown relay becomes a custom setting", () => {
    const s = defaultSettings({ VITE_RELAY_URL: "http://relay.example" });
    expect(s).toMatchObject({ preset: "custom", customUrl: "http://relay.example" });
  });
});

describe("migrateSettings", () => {
  test("junk becomes the default rather than breaking the client", () => {
    expect(migrateSettings("nonsense", {}).preset).toBe("railway");
    expect(migrateSettings(null, {}).chainIds).toHaveLength(3);
  });

  test("an unknown chain id is dropped, and an empty list falls back to the preset's", () => {
    const s = migrateSettings({ preset: "local", customUrl: "", chainIds: [999, CELO_SEPOLIA.chainId] }, {});
    expect(s.chainIds).toEqual([CELO_SEPOLIA.chainId]);
    expect(migrateSettings({ preset: "fork", chainIds: [] }, {}).chainIds).toEqual(presetById("fork").chainIds);
  });
});

describe("chainsFor", () => {
  test("configures only the chosen chains, and points every one at the relay", () => {
    const settings: Settings = { preset: "local", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] };
    const chains = chainsFor(settings, {});
    expect(chains.map((c) => c.chainId)).toEqual([CELO_SEPOLIA.chainId]);
    expect(chains[0]!.relayUrl).toBe(LOCAL);
  });

  test("the relay override reaches the registry chain nested inside a cached config", () => {
    const chains = chainsFor({ preset: "fork", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] }, {});
    const registry = chains[0]!.registry;
    expect(registry?.kind).toBe("cached");
    if (registry?.kind === "cached") expect(registry.l1.relayUrl).toBe(FORK);
  });

  test("an empty chain list still yields a usable client rather than throwing", () => {
    expect(chainsFor({ preset: "railway", customUrl: "", chainIds: [] }, {}).map((c) => c.chainId)).toEqual([
      CELO_SEPOLIA.chainId,
    ]);
  });

  test("a per-chain RPC override survives the relay override", () => {
    const chains = chainsFor(
      { preset: "local", customUrl: "", chainIds: [CELO_SEPOLIA.chainId] },
      { [`VITE_RPC_${CELO_SEPOLIA.chainId}`]: "http://rpc.example" },
    );
    expect(chains[0]!.publicRpcUrl).toBe("http://rpc.example");
    expect(chains[0]!.relayUrl).toBe(LOCAL);
  });

  test("applyEnv is unchanged for callers that still pass env directly", () => {
    expect(applyEnv(BASE_SEPOLIA, { VITE_RELAY_URL: LOCAL }).relayUrl).toBe(LOCAL);
  });
});
