import { NATIVE_TOKEN, type ExecuteResult, type HoldingsResult } from "@altananetwork/sdk";
import { useEffect, useState } from "react";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { chainName } from "../lib/chains";
import { txUrl } from "../lib/explorer";
import { feeTokenOption, nativeLabel, symbolFor, type FeeMode } from "../lib/fees";
import { formatAmount, isAddress, parseAmount, sameAddress } from "../lib/format";
import { useApp, useRun } from "../state/AppState";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

type Outcome = { result: ExecuteResult; before: HoldingsResult; after?: HoldingsResult };

export function SendPanel() {
  const { state, dispatch, client } = useApp();
  const run = useRun();
  const chains = client.chains;
  const wallet = state.wallet;
  const currencies = state.feeCurrenciesChainId === state.chainId ? (state.feeCurrencies ?? []) : [];
  const native = nativeLabel(state.chainId, currencies, chains);
  const holdings = state.holdingsChainId === state.chainId ? state.holdings : undefined;

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.001");
  const [asset, setAsset] = useState<string>("native");
  const [mode, setMode] = useState<FeeMode>("auto");
  const [one, setOne] = useState<Address>(NATIVE_TOKEN);
  const [list, setList] = useState<Address[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  useEffect(() => {
    if (state.feeCurrenciesChainId !== state.chainId) {
      void run("feeCurrencies", async () => {
        const r = await client.feeCurrencies(state.chainId);
        dispatch({ type: "fees/set", chainId: state.chainId, currencies: r.currencies });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.chainId]);

  const heldTokens = holdings?.tokens.filter((t) => t.ok && t.raw > 0n) ?? [];

  const send = () =>
    run("execute", async () => {
      setError(undefined);
      if (!wallet) return;
      if (!isAddress(to)) {
        setError("Recipient must be an address.");
        return;
      }
      let calls;
      try {
        if (asset === "native") {
          calls = [{ to: to as Address, value: parseAmount(amount, 18), data: "0x" as const }];
        } else {
          const token = heldTokens.find((t) => t.ok && sameAddress(t.address, asset));
          if (!token || !token.ok) throw new Error("Pick a token the wallet holds.");
          calls = [
            {
              to: token.address,
              value: 0n,
              data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, parseAmount(amount, token.decimals)] }),
            },
          ];
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      const feeToken = feeTokenOption(mode, one, list);
      setBusy(true);
      try {
        const before = holdings ?? (await client.holdings(wallet.address, state.chainId));
        const result = await client.execute({
          wallet: { address: wallet.address },
          signer: wallet.signer,
          calls,
          chainId: state.chainId,
          ...(feeToken !== undefined ? { feeToken } : {}),
        });
        setOutcome({ result, before });
        const after = await client.holdings(wallet.address, state.chainId);
        dispatch({ type: "holdings/set", chainId: state.chainId, holdings: after });
        setOutcome({ result, before, after });
      } finally {
        setBusy(false);
      }
    });

  const toggleInList = (address: Address) =>
    setList((l) => (l.some((a) => sameAddress(a, address)) ? l.filter((a) => !sameAddress(a, address)) : [...l, address]));

  return (
    <div className="panel">
      <h2>Send</h2>
      <p className="lead">
        A transfer on {chainName(state.chainId, chains)} through the relay. Leave the fee on automatic to see which token the relay
        charges from what the wallet holds, or force one.
      </p>
      {!wallet && <div className="banner info">Create a wallet first.</div>}
      {wallet && (
        <>
          <Card title="Transfer">
            <Field label="Recipient" htmlFor="send-to" error={error && error.includes("Recipient") ? error : undefined}>
              <input id="send-to" value={to} placeholder="0x…" onChange={(e) => setTo(e.target.value)} />
            </Field>
            <div className="row">
              <Field label="Amount" htmlFor="send-amount" error={error && error.includes("Amount") ? error : undefined}>
                <input id="send-amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Asset" htmlFor="send-asset">
                <select id="send-asset" value={asset} onChange={(e) => setAsset(e.target.value)}>
                  <option value="native">{native}</option>
                  {heldTokens.map((t) => (t.ok ? <option key={t.address} value={t.address}>{t.symbol}</option> : null))}
                </select>
              </Field>
            </div>
          </Card>

          <Card title="Relay fee" hint="How the relay's fee is paid for this transaction.">
            <div className="row" role="radiogroup" aria-label="Fee mode">
              {(
                [
                  ["auto", "Automatic: the relay picks a token the wallet holds"],
                  ["one", "Force one token"],
                  ["list", "Choose from a list, first accepted and held"],
                ] as const
              ).map(([m, label]) => (
                <label key={m} className="row" style={{ gap: 6 }}>
                  <input type="radio" name="fee-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                  {label}
                </label>
              ))}
            </div>
            {mode === "one" && (
              <Field label="Fee token" htmlFor="fee-one">
                <select id="fee-one" value={one} onChange={(e) => setOne(e.target.value as Address)}>
                  {currencies.map((c) => (
                    <option key={c.uid} value={c.address}>
                      {c.symbol}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {mode === "list" && (
              <div className="stack">
                <span className="muted small">Tick in the order of preference.</span>
                {currencies.map((c) => (
                  <label key={c.uid} className="row" style={{ gap: 6 }}>
                    <input type="checkbox" checked={list.some((a) => sameAddress(a, c.address))} onChange={() => toggleInList(c.address)} />
                    {c.symbol}
                    {list.findIndex((a) => sameAddress(a, c.address)) >= 0 && (
                      <span className="muted small">#{list.findIndex((a) => sameAddress(a, c.address)) + 1}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
            {error && !error.includes("Recipient") && !error.includes("Amount") && <div className="banner error">{error}</div>}
            <div className="row">
              <Button variant="primary" onClick={send} disabled={busy}>
                {busy ? "Sending…" : "Send"}
              </Button>
            </div>
          </Card>

          {outcome && (
            <Card title="Result">
              <div className="row">
                <Badge tone={outcome.result.status === "CONFIRMED" ? "success" : outcome.result.status === "FAILED" ? "error" : "warning"}>
                  {outcome.result.status}
                </Badge>
                <span>
                  Charged in <strong style={{ fontWeight: 500 }}>{symbolFor(outcome.result.feeToken, currencies)}</strong>
                </span>
                {outcome.result.transactionHash && (
                  <a href={txUrl(state.chainId, outcome.result.transactionHash)} target="_blank" rel="noreferrer">
                    View transaction
                  </a>
                )}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{native}</td>
                    <td className="num">{formatAmount(outcome.before.native, 18)}</td>
                    <td className="num">{outcome.after ? formatAmount(outcome.after.native, 18) : "…"}</td>
                  </tr>
                  {outcome.before.tokens.map((t) =>
                    t.ok ? (
                      <tr key={t.address}>
                        <td>{t.symbol}</td>
                        <td className="num">{t.display}</td>
                        <td className="num">
                          {outcome.after
                            ? (() => {
                                const a = outcome.after.tokens.find((x) => sameAddress(x.address, t.address));
                                return a && a.ok ? a.display : "0";
                              })()
                            : "…"}
                        </td>
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
