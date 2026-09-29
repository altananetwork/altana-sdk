import { networkByChainId } from "@altananetwork/sdk";
import { ALL_CHAIN_IDS, presetById, relayUrlOf, RELAY_PRESETS, type Settings } from "../lib/settings";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

export type SettingsPanelProps = {
  settings: Settings;
  onChange(next: Settings): void;
};

/**
 * Which relay the bench talks to, and which chains it configures.
 *
 * Picking a preset also sets its chain list, because the three relays do not
 * serve the same chains and configuring one a relay does not serve fails
 * before anything useful happens.
 */
export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const preset = presetById(settings.preset);
  const url = relayUrlOf(settings);

  function choose(id: Settings["preset"]) {
    const next = presetById(id);
    onChange({ ...settings, preset: id, chainIds: [...next.chainIds] });
  }

  function toggleChain(chainId: number, on: boolean) {
    const chainIds = on
      ? [...new Set([...settings.chainIds, chainId])]
      : settings.chainIds.filter((c) => c !== chainId);
    onChange({ ...settings, chainIds });
  }

  return (
    <div className="panel">
      <h2>Settings</h2>
      <p className="lead">
        The relay the bench talks to. Switching it reloads the client, so the wallet and any stored sessions stay
        where they are while the relay changes underneath them.
      </p>

      <Card title="Relay">
        <div className="stack">
          {RELAY_PRESETS.map((p) => (
            <label key={p.id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
              <input
                type="radio"
                name="relay-preset"
                checked={settings.preset === p.id}
                onChange={() => choose(p.id)}
              />
              <span className="stack" style={{ gap: 2 }}>
                <span>
                  {p.label}
                  {p.url && <span className="muted small"> {p.url}</span>}
                </span>
                <span className="muted small">{p.note}</span>
              </span>
            </label>
          ))}

          {settings.preset === "custom" && (
            <Field label="Relay URL" htmlFor="relay-url">
              <input
                id="relay-url"
                value={settings.customUrl}
                placeholder="http://127.0.0.1:19129"
                onChange={(e) => onChange({ ...settings, customUrl: e.target.value })}
              />
            </Field>
          )}

          {!url && (
            <div className="banner error" role="alert">
              No relay URL. The bench cannot reach a relay until one is set.
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Chains"
        hint="Only these are configured. A chain the relay does not serve fails on the first call with an error that names neither, so leave it off."
      >
        <div className="stack">
          {ALL_CHAIN_IDS.map((chainId) => {
            const network = networkByChainId(chainId);
            const served = preset.chainIds.includes(chainId);
            return (
              <label key={chainId} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.chainIds.includes(chainId)}
                  onChange={(e) => toggleChain(chainId, e.target.checked)}
                />
                <span>{network?.chain.name ?? `chain ${chainId}`}</span>
                {!served && <span className="muted small">not served by {preset.label}</span>}
              </label>
            );
          })}
          {settings.chainIds.length === 0 && (
            <div className="banner error" role="alert">
              Pick at least one chain.
            </div>
          )}
        </div>
      </Card>

      <Card title="Reset">
        <div className="row">
          <Button onClick={() => choose(settings.preset)}>Restore this relay&apos;s chains</Button>
        </div>
      </Card>
    </div>
  );
}
