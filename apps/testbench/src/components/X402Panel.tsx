import { CELO_SEPOLIA, deserializeSession, signerFromPrivateKey } from "@altananetwork/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import type { X402ApprovalStatus } from "@altananetwork/sdk";
import { relayReason } from "../lib/errors";
import { txUrl } from "../lib/explorer";
import { entry } from "../lib/log";
import {
  amountOf,
  explainX402Failure,
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
 * The panel shows which rail carried the payment, and which contract verified
 * the signature, because those are two different things and the second is what
 * needs approving. A smart account pays on either rail; what differs is whether
 * Permit2 or the token itself calls back to verify, and that contract must be
 * an approved checker for the session key.
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
      // A facilitator failure is a chain revert it relayed; explain it rather
      // than showing "unexpected_error: execution reverted" and leaving the
      // reader to guess whose fault it was.
      const reason = explainX402Failure(relayReason(err));
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

  const [approvals, setApprovals] = useState<X402ApprovalStatus>();

  // Both rails need an approved signature checker, and they need different
  // ones: Permit2 on the permit2 rails, the **token itself** on eip3009. This
  // panel used to model only the first, so an eip3009 payment failed with
  // "FiatTokenV2: invalid signature" and no guidance
  // (evidence/2026-10-05-celo-usdc-does-honour-erc1271.md). The SDK reads both
  // from chain, so the panel no longer infers which is missing.
  const payToken = health?.token as Address | undefined;
  const wallet = app.wallet;
  const chosenRequirement = probe?.chosen;

  const refreshApprovals = useCallback(async () => {
    if (!selected || !chosenRequirement) {
      setApprovals(undefined);
      return;
    }
    try {
      const session = deserializeSession(selected.serialized, signerFromPrivateKey(selected.sessionKey));
      setApprovals(await client.x402Approvals({ session, req: chosenRequirement }));
    } catch {
      setApprovals(undefined);
    }
  }, [client, selected, chosenRequirement]);

  useEffect(() => {
    void refreshApprovals();
  }, [refreshApprovals]);

  /**
   * Repairs a session granted before `x402Tokens` existed. A session granted
   * with it needs none of this, which is the better flow and the one the
   * Sessions tab now takes.
   */
  const repairApprovals = () =>
    guard("repairApprovals", async () => {
      if (!wallet || !payToken || !selected || !approvals) return;
      const session = deserializeSession(selected.serialized, signerFromPrivateKey(selected.sessionKey));
      if (approvals.permit2Allowance && !approvals.permit2Allowance.ok) {
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
      if (!approvals.checkerApproved) {
        const approved = await client.approveX402Checker({
          chainId: CELO,
          wallet: wallet.address,
          // The admin signs it: setSignatureCheckerApproval is onlyThis.
          signer: wallet.signer,
          session,
          checker: approvals.checker,
        });
        if (approved.status !== "CONFIRMED") {
          throw new Error(`Approving ${approvals.checker} as a signature checker returned ${approved.status}.`);
        }
      }
      await refreshApprovals();
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
                  {/* The seller reports which rails it routes; the panel does
                      not assume. That split is this seller's configuration and
                      not a property of the facilitator. */}
                  <th scope="row">Settles through the facilitator</th>
                  <td>
                    {health.facilitator ? (
                      <span>
                        {health.facilitatorRails?.length
                          ? `${health.facilitatorRails.join(", ")} at `
                          : "nothing, though it is configured with "}
                        <span className="addr">{health.facilitator}</span>
                      </span>
                    ) : (
                      "nothing: it settles from its own key, because X402_CELO_API_KEY is not set"
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
              help="A smart account can pay on either. They differ in which contract verifies its signature, and so in which approval the session needs."
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

          {approvals && !approvals.ok && (
            <div className="banner info">
              <div className="stack">
                <span>
                  This session is not set up for the {approvals.rail} rail yet. The contract that verifies its
                  signature is <span className="addr">{approvals.checker}</span>, and it must be approved for
                  this key:
                </span>
                <ul className="stack" style={{ gap: 2 }}>
                  {approvals.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <div className="row">
                  <Button onClick={() => void repairApprovals()} disabled={busy !== undefined || !wallet}>
                    {busy === "repairApprovals" ? "Approving" : "Approve them for this session"}
                  </Button>
                </div>
                <span className="muted small">
                  A session granted with the x402 tokens ticked needs none of this. The Sessions tab does that
                  now; this repairs one granted before it.
                </span>
              </div>
            </div>
          )}

          {approvals?.ok && (
            <p className="muted small">
              {approvals.isSuperAdmin
                ? "This key is a super admin, which the account accepts from any contract, so no checker approval is needed."
                : `Approved: ${approvals.checker} can verify this key's signatures on the ${approvals.rail} rail, which is what that rail needs.`}
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
