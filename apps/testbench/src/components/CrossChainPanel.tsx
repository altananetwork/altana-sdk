import { networkByChainId, type NetworkConfig } from "@altananetwork/sdk";
import { useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { DESTINATION_CHAIN_ID, STEPS, keyIdOf, runCrossChain, type CrossChainDeps, type CrossChainResult, type StepState } from "../lib/crossChain";
import { txUrl } from "../lib/explorer";
import { nativeLabel } from "../lib/fees";
import { formatAmount } from "../lib/format";
import { entry } from "../lib/log";
import { useApp } from "../state/AppState";
import { Address } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

export type DepsFactory = (args: { walletKey: Hex; source: NetworkConfig }) => Promise<CrossChainDeps>;

const liveFactory: DepsFactory = async (args) => (await import("../lib/crossChainLive")).liveDeps(args);

export function CrossChainPanel({ makeDeps = liveFactory }: { makeDeps?: DepsFactory }) {
  const { state, dispatch, client } = useApp();
  const wallet = state.wallet;
  const sources = client.chains.filter((c) => c.chainId !== DESTINATION_CHAIN_ID);
  const [sourceId, setSourceId] = useState<number>(sources[0]?.chainId ?? 0);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [result, setResult] = useState<CrossChainResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const source = sources.find((c) => c.chainId === sourceId);
  const destination = networkByChainId(DESTINATION_CHAIN_ID);
  const publicKey = wallet ? privateKeyToAccount(wallet.key).publicKey : undefined;
  const sourceSymbol = source ? nativeLabel(source.chainId, state.feeCurrenciesChainId === source.chainId ? state.feeCurrencies : undefined, client.chains) : "CELO";

  const start = async () => {
    if (!wallet || !source || !publicKey) return;
    setError(undefined);
    setResult(undefined);
    setSteps([]);
    setBusy(true);
    const onStep = (s: StepState) => {
      setSteps((prev) => [...prev.filter((p) => p.step !== s.step), s]);
      dispatch({ type: "log/add", entry: entry(`cross-chain ${s.step}`, s.state === "failed" ? { error: s.detail, level: "error" } : { result: s.detail ?? s.state }) });
    };
    try {
      const deps = await makeDeps({ walletKey: wallet.key, source });
      const r = await runCrossChain(deps, { wallet: wallet.address, publicKey, onStep });
      setResult(r);
      dispatch({ type: "log/add", entry: entry("cross-chain result", { result: r }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>Cross-chain registration</h2>
      <p className="lead">
        A wallet holding only the source chain's native token registers its key in the Sepolia KeyStore. The relay locks funds on
        the source chain, pays the registration in ETH on Sepolia, and is repaid when the escrow settles. One signature.
      </p>
      <div className="banner" role="note">
        Demo pricing: the testnet relay counts 1 {sourceSymbol} as 1 ETH. The amount locked on the source chain is not a market
        price. Real conversion at an oracle rate is a separate relay change.
      </div>
      {!wallet && <div className="banner info">Create a wallet first.</div>}
      {wallet && (
        <>
          <Card title="Setup">
            <Field label="Source chain" htmlFor="xc-source">
              <select id="xc-source" value={sourceId} onChange={(e) => setSourceId(Number(e.target.value))}>
                {sources.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.chain.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="stack small">
              <span>
                Wallet <Address value={wallet.address} /> registers key <Address value={publicKey ? keyIdOf(publicKey) : ""} /> on {destination?.chain.name}.
              </span>
              <span className="muted">The wallet should hold {sourceSymbol} on {source?.chain.name} and nothing on Sepolia; this key must not be registered yet.</span>
            </div>
            <div className="row">
              <Button variant="primary" onClick={start} disabled={busy || !source}>
                {busy ? "Running…" : "Register through the relay"}
              </Button>
            </div>
          </Card>

          {steps.length > 0 && (
            <Card title="Steps">
              <ol className="stack" style={{ margin: 0, paddingLeft: 18 }}>
                {STEPS.map((s) => {
                  const st = steps.find((x) => x.step === s.id);
                  return (
                    <li key={s.id} className="row">
                      <span>{s.label}</span>
                      {st && <Badge tone={st.state === "done" ? "success" : st.state === "failed" ? "error" : st.state === "running" ? "accent" : undefined}>{st.state}</Badge>}
                      {st?.detail && <span className="muted small">{st.detail}</span>}
                    </li>
                  );
                })}
              </ol>
            </Card>
          )}

          {error && <div className="banner error" role="alert">{error}</div>}

          {result && (
            <Card title="Result">
              <div className="row">
                {result.valid ? <Badge tone="success">Key valid in the Sepolia KeyStore</Badge> : <Badge tone="error">Key not found</Badge>}
              </div>
              <table className="table">
                <tbody>
                  <tr>
                    <td>Registration fee</td>
                    <td className="num">{formatAmount(result.fee, 18)} ETH</td>
                  </tr>
                  <tr>
                    <td>Locked on {source?.chain.name}</td>
                    <td className="num">
                      {formatAmount(result.escrowed, 18)} {sourceSymbol} <span className="muted small">(demo pricing)</span>
                    </td>
                  </tr>
                  <tr>
                    <td>Source fee, at most</td>
                    <td className="num">
                      {formatAmount(result.sourceFeeMax, 18)} {sourceSymbol}
                    </td>
                  </tr>
                  <tr>
                    <td>Quotes under one root</td>
                    <td>{result.quoteChainIds.map((id) => networkByChainId(id)?.chain.name ?? id).join(", ")}</td>
                  </tr>
                  {result.multiChainRoot && (
                    <tr>
                      <td>Multichain root</td>
                      <td>
                        <Address value={result.multiChainRoot} />
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td>Bundle</td>
                    <td>
                      <Address value={result.bundleId} />
                    </td>
                  </tr>
                  {result.receipts.map((r) => (
                    <tr key={`${r.chainId}-${r.transactionHash}`}>
                      <td>{networkByChainId(r.chainId)?.chain.name ?? r.chainId} transaction</td>
                      <td>
                        <Address value={r.transactionHash} href={txUrl(r.chainId, r.transactionHash)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
