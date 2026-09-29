import { CELO_SEPOLIA, deserializeSession, signerFromPrivateKey } from "@altananetwork/sdk";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { relayReason } from "../lib/errors";
import { txUrl } from "../lib/explorer";
import { entry } from "../lib/log";
import {
  amountOf,
  probeX402,
  railOf,
  railNote,
  readPaidResponse,
  readSellerHealth,
  type Rail,
  type SellerHealth,
  type X402Payment,
  type X402Probe,
} from "../lib/x402";
import { useDebounced } from "../lib/useDebounced";
import { useApp } from "../state/AppState";
import { Address as Addr } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

const CELO = CELO_SEPOLIA.chainId;
const DEFAULT_URL = "http://127.0.0.1:4021/paid";

/**
 * Paying per request on Celo Sepolia, from a granted session key.
 *
 * The panel shows which rail carried the payment because on Celo that is the
 * whole story: an Altana smart account can only pay on Permit2, and Celo's
 * facilitator only settles EIP-3009. So an agent wallet's payment settles from
 * the merchant's key, and the facilitator route is for EOA buyers.
 */
export function X402Panel() {
  const { state: app, dispatch, client } = useApp();
  const [url, setUrl] = useState(DEFAULT_URL);
  const [sessionId, setSessionId] = useState<string>("");
  const [rail, setRail] = useState<Rail>("permit2");
  const [probe, setProbe] = useState<X402Probe>();
  const [paid, setPaid] = useState<X402Payment>();
  const [health, setHealth] = useState<SellerHealth>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const sessions = app.sessions.filter((s) => s.status !== "failed");
  const selected = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const [allowance, setAllowance] = useState<bigint>();

  // Permit2 pulls the token with permitTransferFrom, which needs the wallet to
  // have approved it first. A fresh wallet has not, so the first payment on
  // that rail fails with something that reads as an x402 problem and is not.
  const payToken = health?.token as Address | undefined;
  const wallet = app.wallet;
  useEffect(() => {
    if (!wallet || !payToken || rail !== "permit2") {
      setAllowance(undefined);
      return;
    }
    let cancelled = false;
    void client
      .permit2Allowance({ chainId: CELO, wallet: wallet.address, token: payToken })
      .then((a) => {
        if (!cancelled) setAllowance(a);
      })
      .catch(() => {
        if (!cancelled) setAllowance(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [client, wallet, payToken, rail]);

  const needsApproval = rail === "permit2" && allowance !== undefined && allowance === 0n;

  const approve = () =>
    guard("approvePermit2", async () => {
      if (!wallet || !payToken) return;
      const result = await client.approvePermit2({
        chainId: CELO,
        wallet: wallet.address,
        signer: wallet.signer,
        token: payToken,
      });
      if (result.status !== "CONFIRMED") {
        throw new Error(`The approval returned ${result.status}.`);
      }
      setAllowance(await client.permit2Allowance({ chainId: CELO, wallet: wallet.address, token: payToken }));
    });

  // Debounced: the field drives a fetch, and one per keystroke is a request
  // storm at a URL that is usually not a seller yet.
  const settledUrl = useDebounced(url);
  useEffect(() => {
    let cancelled = false;
    void readSellerHealth(settledUrl).then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, [settledUrl]);

  async function guard(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      const reason = relayReason(err);
      setError(reason);
      dispatch({ type: "log/add", entry: entry(label, { error: reason, level: "error" }) });
    } finally {
      setBusy(undefined);
    }
  }

  const ask = () =>
    guard("x402 probe", async () => {
      setPaid(undefined);
      const result = await probeX402(url);
      setProbe(result);
      dispatch({ type: "log/add", entry: entry("x402 probe", { result }) });
    });

  const pay = () =>
    guard("x402 pay", async () => {
      if (!selected) return;
      const session = deserializeSession(selected.serialized, signerFromPrivateKey(selected.sessionKey));
      const res = await client.fetchWithX402({ session, url, preferRail: rail, chainId: CELO });
      const answer = await readPaidResponse(res);
      setPaid(answer);
      dispatch({ type: "log/add", entry: entry("x402 pay", { result: answer }) });
    });

  return (
    <div className="panel">
      <h2>x402</h2>
      <p className="lead">
        Pay per request on Celo Sepolia from a session key. The seller is a local x402-server merchant that
        verifies and settles the payment on chain, and reports which rail carried it.
      </p>

      <Card title="The seller">
        <div className="stack">
          <Field
            label="Paid URL"
            htmlFor="x402-url"
            help="Start the seller with bun run serve:x402-celo, from tests/e2e. It builds the x402-server package first, so it works from a clean checkout."
          >
            <input id="x402-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          {health ? (
            <table className="table">
              <tbody>
                <tr>
                  <th scope="row">Price</th>
                  <td>{health.price ? `${Number(health.price) / 1e6} USDC per request` : "unknown"}</td>
                </tr>
                <tr>
                  <th scope="row">Pays out to</th>
                  <td>{health.payTo && <Addr value={health.payTo} />}</td>
                </tr>
                <tr>
                  <th scope="row">Settles EIP-3009 through</th>
                  <td>
                    {health.facilitator ? (
                      <span>
                        Celo&apos;s facilitator, <span className="addr">{health.facilitator}</span>
                      </span>
                    ) : (
                      "its own key, because X402_CELO_API_KEY is not set"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="banner info">
              No seller answering at that address yet. Start one with bun run serve:x402-celo from tests/e2e,
              with the shared testnet env sourced. That script builds the x402-server package before it starts,
              so a clean checkout works.
            </div>
          )}
        </div>
      </Card>

      <Card title="Buy one request">
        <div className="stack">
          <div className="row">
            <Field label="Pay with" htmlFor="x402-session">
              <select id="x402-session" value={selected?.id ?? ""} onChange={(e) => setSessionId(e.target.value)}>
                {sessions.length === 0 && <option value="">No session yet</option>}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.keyId.slice(0, 10)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Preferred rail"
              htmlFor="x402-rail"
              help="Permit2 is the only rail an Altana smart account can pay on."
            >
              <select id="x402-rail" value={rail} onChange={(e) => setRail(e.target.value as Rail)}>
                <option value="permit2">Permit2</option>
                <option value="eip3009">EIP-3009</option>
              </select>
            </Field>
          </div>

          {sessions.length === 0 && (
            <div className="banner info">
              Grant a session on the Sessions tab first. An x402 payment is signed by a session key, not by the
              wallet key. On a live relay, untick the KeyStore write there or the grant fails.
            </div>
          )}

          {needsApproval && (
            <div className="banner info">
              <div className="stack">
                <span>
                  This wallet has not approved Permit2 for that token. Permit2 pulls the payment with
                  permitTransferFrom, so without the approval the first payment on this rail fails with an error
                  that says nothing about approvals.
                </span>
                <div className="row">
                  <Button onClick={() => void approve()} disabled={busy !== undefined || !wallet}>
                    {busy === "approvePermit2" ? "Approving" : "Approve Permit2 for this token"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="row">
            <Button onClick={() => void ask()} disabled={busy !== undefined}>
              Ask what it charges
            </Button>
            <Button
              variant="primary"
              onClick={() => void pay()}
              disabled={busy !== undefined || !selected}
            >
              {busy === "x402 pay" ? "Paying" : "Pay and fetch"}
            </Button>
          </div>

          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
        </div>
      </Card>

      {probe && (
        <Card title="What the seller takes">
          {probe.unexpected ? (
            <div className="banner error" role="alert">
              That URL answered {probe.unexpected.status}, not 402, so it is not a paid route. Nothing was paid.
            </div>
          ) : (
            <div className="stack">
              <span className="muted small">x402 version {probe.version ?? "unstated"}</span>
              <table className="table">
                <thead>
                  <tr>
                    <th>Scheme</th>
                    <th>Network</th>
                    <th>Asset</th>
                    <th>Rail</th>
                    <th>Amount</th>
                    <th>Pays with</th>
                  </tr>
                </thead>
                <tbody>
                  {probe.accepts.map((a, i) => (
                    <tr key={`${a.network}-${a.asset}-${i}`}>
                      <td>{a.scheme}</td>
                      <td>{a.network}</td>
                      <td>{a.asset && <Addr value={a.asset} />}</td>
                      <td className="muted small">{railOf(a) ?? "unstated"}</td>
                      <td className="num">{amountOf(a) ?? "unstated"}</td>
                      <td>{a === probe.chosen && <Badge tone="accent">Chosen</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {probe.accepts.length > 0 && !probe.chosen && (
                <div className="banner error" role="alert">
                  None of the seller&apos;s options is one this SDK can pay.
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {paid && (
        <Card title="The payment">
          <div className="stack">
            <div className="row" style={{ gap: 8 }}>
              <Badge tone={paid.status === 200 ? "success" : "error"}>
                {paid.status === 200 ? "Paid" : `Seller answered ${paid.status}`}
              </Badge>
              {paid.rail && <Badge tone="accent">{paid.rail}</Badge>}
              {paid.settledVia && <Badge>settled by the {paid.settledVia}</Badge>}
            </div>
            <p>{railNote(paid.rail)}</p>
            {paid.txHash && (
              <div className="row" style={{ gap: 8 }}>
                <span className="muted small">Settlement</span>
                <Addr value={paid.txHash} href={txUrl(CELO, paid.txHash)} />
                {paid.settlement && <span className="muted small">{paid.settlement}</span>}
              </div>
            )}
            {paid.data && <p className="muted">{paid.data}</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
