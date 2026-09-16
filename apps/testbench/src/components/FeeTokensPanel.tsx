import { useEffect, useState } from "react";
import { chainName } from "../lib/chains";
import { tokenUrl } from "../lib/explorer";
import { isHeld, nativeLabel } from "../lib/fees";
import { rateStrings } from "../lib/format";
import { useApp, useRun } from "../state/AppState";
import { Address } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";

export function FeeTokensPanel() {
  const { state, dispatch, client } = useApp();
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const [ttl, setTtl] = useState<number>();
  const chains = client.chains;
  const currencies = state.feeCurrenciesChainId === state.chainId ? state.feeCurrencies : undefined;
  const native = nativeLabel(state.chainId, currencies, chains);
  const holdings = state.holdingsChainId === state.chainId ? state.holdings : undefined;

  const refresh = () =>
    run("feeCurrencies", async () => {
      setBusy(true);
      try {
        const r = await client.feeCurrencies(state.chainId);
        setTtl(r.rateTtl);
        dispatch({ type: "fees/set", chainId: state.chainId, currencies: r.currencies });
      } finally {
        setBusy(false);
      }
    });

  useEffect(() => {
    if (state.feeCurrenciesChainId !== state.chainId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.chainId]);

  return (
    <div className="panel">
      <h2>Fee tokens</h2>
      <p className="lead">
        What the relay accepts as payment for its fee on {chainName(state.chainId, chains)}, read live from the relay.
        A wallet holding any of these can transact without {native}.
      </p>
      <Card>
        <div className="row between">
          <span className="muted">{ttl !== undefined ? `Rates are refreshed by the relay; a rate older than ${ttl} seconds is not quoted.` : ""}</span>
          <Button variant="primary" onClick={refresh} disabled={busy}>
            Refresh
          </Button>
        </div>
        {!currencies && <p className="muted">Loading fee tokens…</p>}
        {currencies && (
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Address</th>
                <th>Rate</th>
                <th>Wallet</th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => {
                const r = rateStrings(c.nativeRate, c.symbol, native);
                const held = isHeld(c, holdings);
                return (
                  <tr key={c.uid}>
                    <td>
                      {c.symbol} <span className="muted small">{c.decimals} decimals</span>
                    </td>
                    <td>{c.isNative ? <span className="muted">native</span> : <Address value={c.address} href={tokenUrl(state.chainId, c.address)} />}</td>
                    <td className="num">
                      {c.isNative ? (
                        <span className="muted">1:1</span>
                      ) : (
                        <span className="stack" style={{ gap: 0 }}>
                          <span>{r.tokenInNative}</span>
                          <span className="muted small">{r.nativeInToken}</span>
                        </span>
                      )}
                    </td>
                    <td>{held ? <Badge tone="success">Held</Badge> : <Badge>Not held</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
