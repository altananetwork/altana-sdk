import { useEffect, useState } from "react";
import { generatePrivateKey } from "viem/accounts";
import { NATIVE_FAUCETS, STABLECOINS, chainName } from "../lib/chains";
import { nativeLabel } from "../lib/fees";
import { addressUrl, tokenUrl } from "../lib/explorer";
import { formatAmount } from "../lib/format";
import { isPrivateKey } from "../lib/storage";
import { useApp, useRun } from "../state/AppState";
import { Address } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

export function WalletPanel() {
  const { state, dispatch, client } = useApp();
  const run = useRun();
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const wallet = state.wallet;
  const chains = client.chains;

  const refresh = () =>
    run("holdings", async () => {
      if (!wallet) return;
      setBusy(true);
      try {
        const holdings = await client.holdings(wallet.address, state.chainId);
        dispatch({ type: "holdings/set", chainId: state.chainId, holdings });
      } finally {
        setBusy(false);
      }
    });

  useEffect(() => {
    if (wallet && state.holdingsChainId !== state.chainId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.address, state.chainId]);

  const register = () =>
    run("createWallet", async () => {
      if (!wallet) return;
      setBusy(true);
      try {
        await client.createWallet(wallet.signer);
        dispatch({ type: "wallet/registered" });
      } finally {
        setBusy(false);
      }
    });

  const native = nativeLabel(state.chainId, state.feeCurrenciesChainId === state.chainId ? state.feeCurrencies : undefined, chains);
  const holdings = state.holdingsChainId === state.chainId ? state.holdings : undefined;

  return (
    <div className="panel">
      <h2>Wallet</h2>
      <p className="lead">
        A test key kept in this browser only. Fund it from a faucet, then register it with the relay.
        Never use a key that holds real funds.
      </p>

      {!wallet && (
        <Card title="Create or import a key">
          <div className="row">
            <Button variant="primary" onClick={() => dispatch({ type: "wallet/set", key: generatePrivateKey() })}>
              Generate a new key
            </Button>
          </div>
          <Field label="Or paste a private key" error={pasteError} htmlFor="paste-key">
            <div className="row">
              <input
                id="paste-key"
                value={pasted}
                placeholder="0x…"
                autoComplete="off"
                onChange={(e) => {
                  setPasted(e.target.value);
                  setPasteError(undefined);
                }}
              />
              <Button
                onClick={() => {
                  const v = pasted.trim();
                  if (!isPrivateKey(v)) {
                    setPasteError("A private key is 0x followed by 64 hex characters.");
                    return;
                  }
                  dispatch({ type: "wallet/set", key: v });
                  setPasted("");
                }}
              >
                Import
              </Button>
            </div>
          </Field>
        </Card>
      )}

      {wallet && (
        <>
          <Card title="Key">
            <div className="row between">
              <div className="stack">
                <span className="muted small">Address</span>
                <Address value={wallet.address} href={addressUrl(state.chainId, wallet.address)} short={false} />
              </div>
              <div className="row">
                {wallet.registered ? <Badge tone="success">Registered with relay</Badge> : <Badge>Not registered yet</Badge>}
              </div>
            </div>
            <div className="row">
              <Button variant="primary" onClick={register} disabled={busy || wallet.registered}>
                Register with relay
              </Button>
              <Button variant="ghost" onClick={() => setRevealed((r) => !r)}>
                {revealed ? "Hide key" : "Reveal key"}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm("Forget this key and its sessions? Funds stay on chain but you lose access here.")) {
                    dispatch({ type: "wallet/clear" });
                    setRevealed(false);
                  }
                }}
              >
                Forget key
              </Button>
            </div>
            {revealed && (
              <div className="stack">
                <span className="muted small">Private key (test only)</span>
                <Address value={wallet.key} short={false} />
              </div>
            )}
          </Card>

          <Card title="Chain">
            <Field label="Active chain" htmlFor="chain">
              <select id="chain" value={state.chainId} onChange={(e) => dispatch({ type: "chain/set", chainId: Number(e.target.value) })}>
                {chains.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.chain.name} ({c.chainId})
                  </option>
                ))}
              </select>
            </Field>
          </Card>

          <Card title="Balances">
            <div className="row between">
              <span className="muted">{chainName(state.chainId, chains)}</span>
              <Button variant="ghost" onClick={refresh} disabled={busy}>
                Refresh
              </Button>
            </div>
            {!holdings && <p className="muted">Loading balances…</p>}
            {holdings && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{native}</td>
                    <td className="num">{formatAmount(holdings.native, 18)}</td>
                  </tr>
                  {holdings.tokens.map((t) =>
                    t.ok ? (
                      <tr key={t.address}>
                        <td>
                          {t.symbol} <Address value={t.address} href={tokenUrl(state.chainId, t.address)} />
                        </td>
                        <td className="num">{t.display}</td>
                      </tr>
                    ) : (
                      <tr key={t.address}>
                        <td>
                          <Address value={t.address} />
                        </td>
                        <td className="muted">{t.error}</td>
                      </tr>
                    ),
                  )}
                  {holdings.tokens.length === 0 && (
                    <tr>
                      <td colSpan={2} className="muted">
                        No tokens held on this chain.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Funding" hint="Send test funds to the address above. Faucets are manual, outside this page.">
            <div className="stack">
              {NATIVE_FAUCETS[state.chainId] && (
                <span>
                  {native}: <a href={NATIVE_FAUCETS[state.chainId]} target="_blank" rel="noreferrer">{NATIVE_FAUCETS[state.chainId]}</a>
                </span>
              )}
              {(STABLECOINS[state.chainId] ?? []).length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Fee token</th>
                      <th>Address</th>
                      <th>Where to get it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(STABLECOINS[state.chainId] ?? []).map((s) => (
                      <tr key={s.address}>
                        <td>
                          {s.symbol} <span className="muted small">{s.decimals} decimals</span>
                        </td>
                        <td>
                          <Address value={s.address} href={tokenUrl(state.chainId, s.address)} />
                        </td>
                        <td>
                          {s.sourceUrl ? (
                            <a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.source}</a>
                          ) : (
                            <span className="muted">{s.source}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
