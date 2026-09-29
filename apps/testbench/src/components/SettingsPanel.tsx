import { networkByChainId } from "@altananetwork/sdk";
import { useEffect, useRef, useState } from "react";
import {
  probeRelay,
  selectionMatches,
  servedAndKnown,
  servedButUnknown,
  type RelayProbe,
} from "../lib/relayCapabilities";
import { ALL_CHAIN_IDS, presetById, relayUrlOf, RELAY_PRESETS, type Settings } from "../lib/settings";
import { useDebounced } from "../lib/useDebounced";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

export type SettingsPanelProps = {
  settings: Settings;
  onChange(next: Settings): void;
  /** Injected in tests; the panel asks the relay what it serves. */
  probe?: typeof probeRelay;
};

/**
 * Which relay the bench talks to, and which chains it configures.
 *
 * Picking a preset also sets its chain list, because the three relays do not
 * serve the same chains and configuring one a relay does not serve fails
 * before anything useful happens.
 */
export function SettingsPanel({ settings, onChange, probe = probeRelay }: SettingsPanelProps) {
  const preset = presetById(settings.preset);
  const url = relayUrlOf(settings);
  const settledUrl = useDebounced(url ?? "");
  const [result, setResult] = useState<RelayProbe>();
  const [asking, setAsking] = useState(false);
  // The probe's answer is applied once per relay, so a chain ticked by hand
  // afterwards is not undone by a later re-render.
  const applied = useRef<string>("");

  // Read through refs so the probe effect depends on the relay alone: adding
  // the settings would re-probe on every tick of a checkbox.
  const onChangeRef = useRef(onChange);
  const settingsRef = useRef(settings);
  onChangeRef.current = onChange;
  settingsRef.current = settings;

  useEffect(() => {
    if (!settledUrl) {
      setResult(undefined);
      return;
    }
    let cancelled = false;
    setAsking(true);
    void probe(settledUrl).then((r) => {
      if (cancelled) return;
      setResult(r);
      setAsking(false);
      const served = servedAndKnown(r, ALL_CHAIN_IDS);
      if (r.status === "serving" && served.length > 0 && applied.current !== settledUrl) {
        applied.current = settledUrl;
        onChangeRef.current({ ...settingsRef.current, chainIds: served });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settledUrl, probe]);

  const served = result ? servedAndKnown(result, ALL_CHAIN_IDS) : [];
  const alsoServes = result ? servedButUnknown(result, ALL_CHAIN_IDS) : [];
  const matches = selectionMatches(settings.chainIds, served);

  function choose(id: Settings["preset"]) {
    const next = presetById(id);
    // The preset's list is only a starting point until the relay answers.
    applied.current = "";
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
          <div className="row" style={{ gap: 8 }}>
            <span className="muted small">What this relay serves</span>
            {asking && <Badge>asking</Badge>}
            {!asking && result?.status === "serving" && (
              <Badge tone="success">answered by the relay</Badge>
            )}
            {!asking && result?.status === "unreachable" && <Badge tone="warning">no answer</Badge>}
          </div>

          {result?.status === "unreachable" && (
            <p className="muted">
              The relay did not say which chains it serves ({result.reason}), so the list below is the preset&apos;s,
              which can be out of date. Tick what you know it serves.
            </p>
          )}

          {ALL_CHAIN_IDS.map((chainId) => {
            const network = networkByChainId(chainId);
            const relaySays =
              result?.status === "serving" ? (served.includes(chainId) ? "yes" : "no") : undefined;
            return (
              <label key={chainId} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={settings.chainIds.includes(chainId)}
                  onChange={(e) => toggleChain(chainId, e.target.checked)}
                />
                <span>{network?.chain.name ?? `chain ${chainId}`}</span>
                {relaySays === "no" && <span className="muted small">this relay does not serve it</span>}
                {relaySays === undefined && !preset.chainIds.includes(chainId) && (
                  <span className="muted small">not in the {preset.label} preset</span>
                )}
              </label>
            );
          })}

          {alsoServes.length > 0 && (
            <p className="muted small">
              The relay also serves {alsoServes.join(", ")}, which the bench has no configuration for.
            </p>
          )}

          {!matches && served.length > 0 && (
            <div className="banner info">
              <div className="stack">
                <span>
                  This relay serves{" "}
                  {served.map((c) => networkByChainId(c)?.chain.name ?? String(c)).join(", ")}, which is not what
                  is ticked above.
                </span>
                <div className="row">
                  <Button onClick={() => onChange({ ...settings, chainIds: served })}>
                    Use the chains this relay serves
                  </Button>
                </div>
              </div>
            </div>
          )}

          {settings.chainIds.length === 0 && (
            <div className="banner error" role="alert">
              Pick at least one chain.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
