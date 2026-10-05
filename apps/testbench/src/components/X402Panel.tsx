import { CELO_SEPOLIA, deserializeSession, PERMIT2_ADDRESS, signerFromPrivateKey } from "@altananetwork/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  accountKeyHashForAddress,
  missingSteps,
  readiness,
  type Permit2Readiness,
} from "../lib/permit2Setup";
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

  const [ready, setReady] = useState<Permit2Readiness>();

  // The Permit2 rail needs two approvals and the panel used to check one, so it
  // looked ready while settlement was still going to revert. qa proved the
  // second on chain by A/B: the only difference between a wallet that settled
  // and one that reverted was Permit2's presence in the session key's
  // approvedSignatureCheckers.
  const payToken = health?.token as Address | undefined;
  const wallet = app.wallet;
  const sessionKeyHash = useMemo(
    () => (selected ? accountKeyHashForAddress(privateKeyToAccount(selected.sessionKey).address) : undefined),
    [selected],
  );

  const refreshReadiness = useCallback(async () => {
    // KNOWN GAP, pending the x402 correction: the eip3009 rail needs the
    // *token* approved as the key's checker, exactly as the permit2 rails need
    // Permit2 (evidence/2026-10-05-celo-usdc-does-honour-erc1271.md). This
    // readiness check models only the permit2 half, so an eip3009 payment from
    // a session without that approval fails with "FiatTokenV2: invalid
    // signature" and no guidance here.
    if (!wallet || !payToken || !sessionKeyHash || rail !== "permit2") {
      setReady(undefined);
      return;
    }
    try {
      const read = await client.permit2Readiness({
        chainId: CELO,
        wallet: wallet.address,
        token: payToken,
        sessionKeyHash,
      });
      setReady(readiness({ ...read, permit2: PERMIT2_ADDRESS }));
    } catch {
      setReady(undefined);
    }
  }, [client, wallet, payToken, sessionKeyHash, rail]);

  useEffect(() => {
    void refreshReadiness();
  }, [refreshReadiness]);

  const setUpPermit2 = () =>
    guard("setUpPermit2", async () => {
      if (!wallet || !payToken || !selected) return;
      const session = deserializeSession(selected.serialized, signerFromPrivateKey(selected.sessionKey));
      // Neither approval is useful without the other, so both run behind one
      // button and a failure in either stops before claiming success.
      if (!ready?.tokenApproved) {
        const approved = await client.approvePermit2Token({
          chainId: CELO,
          wallet: wallet.address,
          signer: wallet.signer,
          token: payToken,
        });
        if (approved.status !== "CONFIRMED") {
          throw new Error(`Approving the token returned ${approved.status}.`);
        }
      }
      if (!ready?.checkerApproved) {
        const approved = await client.approvePermit2Checker({
          chainId: CELO,
          wallet: wallet.address,
          // The admin signs it: setSignatureCheckerApproval is onlyThis.
          signer: wallet.signer,
          session,
        });
        if (approved.status !== "CONFIRMED") {
          throw new Error(`Approving Permit2 as a signature checker returned ${approved.status}.`);
        }
      }
      await refreshReadiness();
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

          {ready && !ready.ready && (
            <div className="banner info">
              <div className="stack">
                <span>This session is not set up for the Permit2 rail yet:</span>
                <ul className="stack" style={{ gap: 2 }}>
                  {missingSteps(ready).map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <div className="row">
                  <Button onClick={() => void setUpPermit2()} disabled={busy !== undefined || !wallet}>
                    {busy === "setUpPermit2" ? "Setting up" : "Set up Permit2 for this session"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {ready?.ready && (
            <p className="muted small">
              Permit2 is approved for the token and for this session key&apos;s signatures, which is both halves
              of what the rail needs.
            </p>
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
