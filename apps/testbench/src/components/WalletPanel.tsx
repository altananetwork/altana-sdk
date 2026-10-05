import { useEffect, useState } from "react";
import { NATIVE_TOKEN } from "@altananetwork/sdk";
import { encodeFunctionData, erc20Abi, type Address as Addr, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { NATIVE_FAUCETS, STABLECOINS, chainName } from "../lib/chains";
import { EMPTY_HOLDINGS_NOTE, SWEEP_SCOPE_NOTE, nativeLabel } from "../lib/fees";
import { addressUrl, tokenUrl, txUrl } from "../lib/explorer";
import { formatAmount, isAddress } from "../lib/format";
import { knownTokensOf } from "../lib/holdings";
import { isPrivateKey } from "../lib/storage";
import { useApp, useEnsureRegistered, useRun } from "../state/AppState";
import { Address } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

export function WalletPanel() {
  const { state, dispatch, client } = useApp();
  const run = useRun();
  const ensureRegistered = useEnsureRegistered();
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveTo, setMoveTo] = useState("");
  const [moveError, setMoveError] = useState<string>();
  const [moved, setMoved] = useState<{ asset: string; status: string; hash?: Hex }[]>();
  const wallet = state.wallet;
  const chains = client.chains;

  const refresh = () =>
    run("holdings", async () => {
      if (!wallet) return;
      setBusy(true);
      try {
        const holdings = await client.mergedHoldings(wallet.address, state.chainId, knownTokensOf(state));
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

  /**
   * Sends every held token in full, then the native balance minus a reserve for
   * the last fee.
   *
   * The token list is re-read here rather than taken from the Balances table.
   * It used to loop over the cached table while re-reading only for the native
   * leg, so a token acquired since the table was last fetched was skipped: qa
   * funded a wallet with USDC after the table loaded, swept, and the USDC
   * stayed behind. The second attempt then failed for asset deficits, because
   * the native balance was gone and the token transfer had no fee to pay with,
   * leaving a wallet holding USDC it could not send.
   *
   * That is the worst possible failure for the one helper whose entire job is
   * not stranding funds, and it fails hardest right after someone has used the
   * wallet, which is exactly when they reach for it.
   */
  const moveAll = () =>
    run("move all funds", async () => {
      setMoveError(undefined);
      if (!wallet) return;
      if (!isAddress(moveTo)) {
        setMoveError("Destination must be an address.");
        return;
      }
      const to = moveTo.trim() as Addr;
      setBusy(true);
      const results: { asset: string; status: string; hash?: Hex }[] = [];
      try {
        await ensureRegistered();
        const held = await client.mergedHoldings(wallet.address, state.chainId, knownTokensOf(state));
        dispatch({ type: "holdings/set", chainId: state.chainId, holdings: held });
        for (const t of held.tokens) {
          if (!t.ok || t.raw === 0n) continue;
          const r = await client.execute({
            wallet: { address: wallet.address },
            signer: wallet.signer,
            chainId: state.chainId,
            calls: [{ to: t.address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, t.raw] }) }],
          });
          results.push({ asset: t.symbol, status: r.status, hash: r.transactionHash });
          setMoved([...results]);
        }
        // The fee comes from the relay's quote for this exact send, never from a guess: send
        // everything minus that fee when the relay charges in the native token, everything
        // when it charges in a token the wallet no longer holds nothing of.
        const current = await client.mergedHoldings(wallet.address, state.chainId, knownTokensOf(state));
        if (current.native > 0n) {
          const quoteArgs = { wallet: { address: wallet.address }, signer: wallet.signer, chainId: state.chainId };
          const q = await client.quoteExecute({ ...quoteArgs, calls: [{ to, value: current.native, data: "0x" }] });
          const value = q.feeToken.toLowerCase() === NATIVE_TOKEN ? current.native - q.fee : current.native;
          if (value <= 0n) throw new Error(`The relay's fee (${formatAmount(q.fee, 18)} ${native}) exceeds the wallet's ${native} balance.`);
          const r = await client.execute({ ...quoteArgs, calls: [{ to, value, data: "0x" }] });
          results.push({ asset: native, status: r.status, hash: r.transactionHash });
          setMoved([...results]);
        }
        dispatch({ type: "holdings/set", chainId: state.chainId, holdings: await client.mergedHoldings(wallet.address, state.chainId, knownTokensOf(state)) });
      } finally {
        setBusy(false);
      }
    });

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
            {revealed && wallet.key && (
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
                        {EMPTY_HOLDINGS_NOTE}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Move all funds" hint="Sends every held token, then the native balance minus the relay's quoted fee, to another address on this chain.">
            <Field label="Destination address" htmlFor="move-to" error={moveError}>
              <div className="row">
                <input id="move-to" value={moveTo} placeholder="0x…" onChange={(e) => setMoveTo(e.target.value)} />
                <Button onClick={moveAll} disabled={busy || !holdings}>
                  {busy ? "Working…" : "Move everything"}
                </Button>
              </div>
            </Field>
            {moved && <p className="muted small">{SWEEP_SCOPE_NOTE}</p>}
            {moved && (
              <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
                {moved.map((m, i) => (
                  <li key={i}>
                    {m.asset}: {m.status} {m.hash && <Address value={m.hash} href={txUrl(state.chainId, m.hash)} />}
                  </li>
                ))}
              </ul>
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
