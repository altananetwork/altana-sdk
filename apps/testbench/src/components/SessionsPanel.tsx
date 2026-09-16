import {
  deserializeSession,
  formatQuoteLine,
  networkByChainId,
  serializeSession,
  signerFromPrivateKey,
  type ExecuteResult,
  type SessionLeg,
  type SessionQuote,
} from "@altananetwork/sdk";
import { useEffect, useState } from "react";
import { generatePrivateKey } from "viem/accounts";
import type { Address } from "viem";
import { txUrl } from "../lib/explorer";
import { nativeLabel, symbolFor } from "../lib/fees";
import { formatAmount, sameAddress } from "../lib/format";
import { entry } from "../lib/log";
import { PERIODS, buildGrant, defaultForm, describeCaps, type SessionForm } from "../lib/sessions";
import type { StoredSession } from "../lib/storage";
import { useApp, useRun } from "../state/AppState";
import { Address as Addr } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";
import { LegsTable } from "./shared/LegsTable";

export function SessionsPanel() {
  const { state, dispatch, client } = useApp();
  const run = useRun();
  const chains = client.chains;
  const wallet = state.wallet;
  const currencies = state.feeCurrenciesChainId === state.chainId ? (state.feeCurrencies ?? []) : [];
  const native = nativeLabel(state.chainId, currencies, chains);

  const [form, setForm] = useState<SessionForm>(() => defaultForm(state.chainId));
  const [error, setError] = useState<string>();
  const [quote, setQuote] = useState<SessionQuote>();
  const [busy, setBusy] = useState<string>();
  const [lastLegs, setLastLegs] = useState<{ title: string; legs: SessionLeg[]; status: string }>();
  const [execResult, setExecResult] = useState<{ id: string; result: ExecuteResult }>();

  useEffect(() => {
    if (state.feeCurrenciesChainId !== state.chainId) {
      void run("feeCurrencies", async () => {
        const r = await client.feeCurrencies(state.chainId);
        dispatch({ type: "fees/set", chainId: state.chainId, currencies: r.currencies });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.chainId]);

  const log = (label: string, detail: unknown) => dispatch({ type: "log/add", entry: entry(label, { result: detail }) });

  const grantArgs = () => {
    if (!wallet) throw new Error("Create a wallet first.");
    const { permissions, expiry } = buildGrant(form, currencies);
    return {
      wallet: { address: wallet.address },
      signer: wallet.signer,
      permissions,
      expiry,
      chainIds: form.chainIds,
      ...(form.feeTokens.length ? { feeToken: form.feeTokens } : {}),
    };
  };

  const doQuote = () =>
    run("quoteGrantSession", async () => {
      setError(undefined);
      let args;
      try {
        args = grantArgs();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      setBusy("quote");
      try {
        setQuote(await client.quoteGrantSession(args));
      } finally {
        setBusy(undefined);
      }
    });

  const doGrant = () =>
    run("grantSession", async () => {
      setError(undefined);
      let args;
      try {
        args = grantArgs();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      const sessionKey = generatePrivateKey();
      setBusy("grant");
      try {
        const result = await client.grantSession({
          ...args,
          sessionSigner: signerFromPrivateKey(sessionKey),
          onStatus: (status, detail) => log("grant status", { status, chainId: detail?.chainId }),
        });
        setLastLegs({ title: "Grant", legs: result.legs, status: result.status });
        if (result.status === "granted") {
          const stored: StoredSession = {
            id: result.keyId,
            name: form.name.trim() || `Session ${new Date().toLocaleString()}`,
            serialized: serializeSession(result),
            sessionKey,
            keyId: result.keyId,
            legs: result.legs,
            createdAt: Date.now(),
          };
          dispatch({ type: "sessions/add", session: stored });
        }
      } finally {
        setBusy(undefined);
      }
    });

  const doExecute = (s: StoredSession) =>
    run("execute (session)", async () => {
      if (!wallet) return;
      setBusy(`exec-${s.id}`);
      try {
        const session = deserializeSession(s.serialized, signerFromPrivateKey(s.sessionKey));
        const result = await client.execute({
          session,
          calls: [{ to: wallet.address, value: 1n, data: "0x" }],
          chainId: state.chainId,
        });
        setExecResult({ id: s.id, result });
        const holdings = await client.holdings(wallet.address, state.chainId);
        dispatch({ type: "holdings/set", chainId: state.chainId, holdings });
      } finally {
        setBusy(undefined);
      }
    });

  const doRevoke = (s: StoredSession) =>
    run("revokeSession", async () => {
      if (!wallet) return;
      setBusy(`revoke-${s.id}`);
      try {
        const session = deserializeSession(s.serialized, signerFromPrivateKey(s.sessionKey));
        const q = await client.quoteRevokeSession({ wallet: { address: wallet.address }, signer: wallet.signer, session });
        log("revoke quote", q);
        const result = await client.revokeSession({
          wallet: { address: wallet.address },
          signer: wallet.signer,
          session,
          onStatus: (status, detail) => log("revoke status", { status, chainId: detail?.chainId }),
        });
        setLastLegs({ title: `Revoke ${s.name}`, legs: result.legs, status: result.status });
        if (result.status === "revoked") dispatch({ type: "sessions/update", id: s.id, patch: { revokedAt: Date.now(), legs: result.legs } });
      } finally {
        setBusy(undefined);
      }
    });

  const setCap = (i: number, patch: Partial<SessionForm["caps"][number]>) =>
    setForm((f) => ({ ...f, caps: f.caps.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  return (
    <div className="panel">
      <h2>Sessions</h2>
      <p className="lead">
        Grant a limited key that an agent can use without the wallet key. A session pays relay fees out of its own spend caps, so
        give it a cap in the token it should pay with.
      </p>
      {!wallet && <div className="banner info">Create a wallet first.</div>}
      {wallet && (
        <>
          <Card title="New session">
            <Field label="Name" htmlFor="s-name">
              <input id="s-name" value={form.name} placeholder="agent one" onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <div className="stack">
              <span className="muted small">Spend caps</span>
              {form.caps.map((c, i) => (
                <div className="row" key={i}>
                  <input aria-label={`Cap ${i + 1} amount`} value={c.amount} onChange={(e) => setCap(i, { amount: e.target.value })} style={{ width: 110 }} />
                  <select aria-label={`Cap ${i + 1} token`} value={c.token} onChange={(e) => setCap(i, { token: e.target.value as Address | "native" })}>
                    <option value="native">{native}</option>
                    {currencies.filter((x) => !x.isNative).map((x) => (
                      <option key={x.uid} value={x.address}>
                        {x.symbol}
                      </option>
                    ))}
                  </select>
                  <span className="muted">per</span>
                  <select aria-label={`Cap ${i + 1} period`} value={c.period} onChange={(e) => setCap(i, { period: e.target.value as SessionForm["caps"][number]["period"] })}>
                    {PERIODS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <Button variant="ghost" aria-label={`Remove cap ${i + 1}`} onClick={() => setForm({ ...form, caps: form.caps.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              ))}
              <div className="row">
                <Button variant="ghost" onClick={() => setForm({ ...form, caps: [...form.caps, { amount: "1", period: "day", token: "native" }] })}>
                  Add a cap
                </Button>
              </div>
            </div>
            <div className="row">
              <Field label="Lifetime (days)" htmlFor="s-days">
                <input id="s-days" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} style={{ width: 90 }} />
              </Field>
              <Field label="Restrict calls to a contract (optional)" htmlFor="s-scope">
                <input id="s-scope" value={form.scopeTo} placeholder="0x…" onChange={(e) => setForm({ ...form, scopeTo: e.target.value })} />
              </Field>
            </div>
            <div className="stack">
              <span className="muted small">Chains</span>
              <div className="row">
                {chains.map((c) => (
                  <label key={c.chainId} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={form.chainIds.includes(c.chainId)}
                      onChange={(e) =>
                        setForm({ ...form, chainIds: e.target.checked ? [...form.chainIds, c.chainId] : form.chainIds.filter((x) => x !== c.chainId) })
                      }
                    />
                    {c.chain.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="stack">
              <span className="muted small">Fee tokens the session may pay with (a daily cap is added for each; none means native only)</span>
              <div className="row">
                {currencies.filter((x) => !x.isNative).map((x) => (
                  <label key={x.uid} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={form.feeTokens.some((a) => sameAddress(a, x.address))}
                      onChange={(e) =>
                        setForm({ ...form, feeTokens: e.target.checked ? [...form.feeTokens, x.address] : form.feeTokens.filter((a) => !sameAddress(a, x.address)) })
                      }
                    />
                    {x.symbol}
                  </label>
                ))}
              </div>
            </div>
            {error && <div className="banner error" role="alert">{error}</div>}
            <div className="row">
              <Button variant="primary" onClick={doGrant} disabled={busy !== undefined}>
                {busy === "grant" ? "Granting…" : "Grant session"}
              </Button>
              <Button onClick={doQuote} disabled={busy !== undefined}>
                {busy === "quote" ? "Quoting…" : "Quote first"}
              </Button>
            </div>
          </Card>

          {quote && (
            <Card title="Quote" hint={quote.complete ? "Every leg could be quoted." : "Some legs could not be quoted; the real cost is higher than shown."}>
              <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
                {quote.lines.map((l, i) => {
                  const n = networkByChainId(l.chainId);
                  return <li key={i}>{n ? formatQuoteLine(l, n) : `${l.chainId} ${l.kind}`}</li>;
                })}
              </ul>
              <table className="table" aria-label="Quote balances">
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th>Asset</th>
                    <th>Balance</th>
                    <th>Needed</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {quote.balances.map((b, i) => (
                    <tr key={i}>
                      <td>{networkByChainId(b.chainId)?.chain.name ?? b.chainId}</td>
                      <td>{b.symbol}</td>
                      <td className="num">{formatAmount(b.balance, 18)}</td>
                      <td className="num">{formatAmount(b.needed, 18)}</td>
                      <td>{b.sufficient ? <Badge tone="success">Enough</Badge> : <Badge tone="error">Short</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {lastLegs && (
            <Card title={`${lastLegs.title}: ${lastLegs.status}`}>
              <LegsTable legs={lastLegs.legs} />
            </Card>
          )}

          <Card title="Stored sessions" hint="Kept in this browser with their keys. Execute sends 1 wei to the wallet itself through the session.">
            {state.sessions.length === 0 && <p className="muted">No sessions yet.</p>}
            {state.sessions.map((s) => (
              <div key={s.id} className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <div className="row between">
                  <div className="row">
                    <strong style={{ fontWeight: 500 }}>{s.name}</strong>
                    {s.revokedAt ? <Badge tone="error">Revoked</Badge> : <Badge tone="success">Active</Badge>}
                  </div>
                  <div className="row">
                    <Button onClick={() => doExecute(s)} disabled={busy !== undefined || !!s.revokedAt}>
                      {busy === `exec-${s.id}` ? "Sending…" : "Execute"}
                    </Button>
                    <Button variant="danger" onClick={() => doRevoke(s)} disabled={busy !== undefined || !!s.revokedAt}>
                      {busy === `revoke-${s.id}` ? "Revoking…" : "Revoke"}
                    </Button>
                    <Button variant="ghost" onClick={() => dispatch({ type: "sessions/remove", id: s.id })}>
                      Forget
                    </Button>
                  </div>
                </div>
                <div className="muted small">
                  Key <Addr value={s.keyId} /> · caps: {describeCaps(s.serialized.permissions.spend ?? [], currencies, native)} · expires{" "}
                  {new Date(s.serialized.expiry * 1000).toLocaleString()}
                </div>
                {execResult?.id === s.id && (
                  <div className="row">
                    <Badge tone={execResult.result.status === "CONFIRMED" ? "success" : "error"}>{execResult.result.status}</Badge>
                    <span>Charged in {symbolFor(execResult.result.feeToken, currencies)}</span>
                    {execResult.result.transactionHash && (
                      <a href={txUrl(state.chainId, execResult.result.transactionHash)} target="_blank" rel="noreferrer">
                        View transaction
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
}
