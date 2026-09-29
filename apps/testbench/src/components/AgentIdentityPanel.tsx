import { CELO_SEPOLIA, erc8004Registry } from "@altananetwork/sdk";
import { useEffect, useState } from "react";
import { relayReason } from "../lib/errors";
import { addressUrl, txUrl } from "../lib/explorer";
import { entry } from "../lib/log";
import {
  agentCardUrl,
  draftAgentRecord,
  isRegistrationRecord,
  loadAgentRecord,
  type AgentRecord,
  type LoadedAgent,
} from "../lib/agentCard";
import { useApp, useEnsureRegistered } from "../state/AppState";
import { Address as Addr } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

const CELO = CELO_SEPOLIA.chainId;
/** The Altana Wallet Agent, registered live on Celo Sepolia on 2026-09-29. */
const ALTANA_AGENT_ID = 449n;

/**
 * ERC-8004 agent identity on Celo: show an existing agent, and mint one for
 * the wallet in use.
 *
 * Celo has the identity registry and none of the ERC-8183 job-escrow stack, so
 * identity works here and hiring does not. The panel says so rather than
 * offering a button that cannot work.
 */
export function AgentIdentityPanel() {
  const { state: app, dispatch, client } = useApp();
  const ensureRegistered = useEnsureRegistered();
  const [agentId, setAgentId] = useState(String(ALTANA_AGENT_ID));
  const [loaded, setLoaded] = useState<LoadedAgent>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("Test bench agent");
  const [description, setDescription] = useState("An agent registered from the Altana test bench.");
  const [minted, setMinted] = useState<{ agentId: bigint; status: string; transactionHash?: string }>();

  const wallet = app.wallet;
  const registry = (() => {
    try {
      return erc8004Registry(CELO);
    } catch {
      return undefined;
    }
  })();

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

  const show = (id: string) =>
    guard("getErc8004Agent", async () => {
      setLoaded(undefined);
      const parsed = BigInt(id);
      const agent = await client.getErc8004Agent({ chainId: CELO, agentId: parsed });
      const { record, problem } = await loadAgentRecord(agent.agentUri);
      setLoaded({ ...agent, ...(record ? { record } : {}), ...(problem ? { problem } : {}) });
    });

  useEffect(() => {
    void show(String(ALTANA_AGENT_ID));
    // Once, for the agent the milestone points at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const register = () =>
    guard("registerErc8004Agent", async () => {
      if (!wallet) return;
      await ensureRegistered();
      const result = await client.registerErc8004Agent({
        chainId: CELO,
        wallet: wallet.address,
        signer: wallet.signer,
        agentUri: draftAgentRecord({ name, description }),
      });
      setMinted(result);
      setAgentId(String(result.agentId));
      await show(String(result.agentId));
    });

  return (
    <div className="panel">
      <h2>Agent identity</h2>
      <p className="lead">
        ERC-8004 identity on Celo. The registry mints a token that is the agent, and the token points at a record
        describing it. Celo has the identity registry and none of the ERC-8183 job-escrow stack, so an agent can
        have an identity here and cannot be hired here.
      </p>

      {registry && (
        <p className="muted">
          Registry <Addr value={registry} href={addressUrl(CELO, registry)} /> on Celo Sepolia.
        </p>
      )}

      <Card title="Show an agent">
        <div className="stack">
          <div className="row">
            <Field label="Agent id" htmlFor="agent-id" help="449 is the Altana Wallet Agent.">
              <input id="agent-id" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
            </Field>
            <Button onClick={() => void show(agentId)} disabled={busy !== undefined}>
              {busy === "getErc8004Agent" ? "Reading" : "Read the registry"}
            </Button>
          </div>

          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}

          {loaded && (
            <div className="stack">
              <table className="table">
                <tbody>
                  <tr>
                    <th scope="row">Owner</th>
                    <td>
                      <Addr value={loaded.owner} href={addressUrl(CELO, loaded.owner)} />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Record</th>
                    <td>
                      {/^https?:/i.test(loaded.agentUri) ? (
                        <a href={loaded.agentUri} target="_blank" rel="noreferrer">
                          {loaded.agentUri}
                        </a>
                      ) : (
                        <span className="muted small">a data URI carried on chain</span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>

              {loaded.problem && (
                <div className="banner info">
                  {loaded.problem} The identity itself is on chain and unaffected.
                </div>
              )}

              {loaded.record && <RecordView record={loaded.record} />}
            </div>
          )}
        </div>
      </Card>

      <Card title="Register this wallet as an agent">
        <div className="stack">
          {!wallet && <div className="banner info">Create a wallet first.</div>}
          <Field label="Name" htmlFor="agent-name">
            <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Description"
            htmlFor="agent-desc"
            help="The record is written on chain as a data URI, so it needs no host."
          >
            <input id="agent-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="row">
            <Button variant="primary" onClick={() => void register()} disabled={!wallet || busy !== undefined}>
              {busy === "registerErc8004Agent" ? "Minting" : "Mint an identity"}
            </Button>
          </div>
          {minted && (
            <div className="row" style={{ gap: 8 }}>
              <Badge tone={minted.status === "CONFIRMED" ? "success" : "error"}>{minted.status}</Badge>
              <span>Agent {String(minted.agentId)}</span>
              {minted.transactionHash && (
                <Addr value={minted.transactionHash} href={txUrl(CELO, minted.transactionHash)} />
              )}
            </div>
          )}
          <p className="muted">
            The mint assigns the id, so the record cannot name it beforehand. The SDK writes the record back in a
            second call when you complete the registration.
          </p>
        </div>
      </Card>
    </div>
  );
}

/**
 * The record the registry points at. Two shapes turn up and both are rendered
 * for what they are: the ERC-8004 registration record, which says where to
 * reach the agent, and an A2A card, which says what it does.
 */
function RecordView({ record }: { record: AgentRecord }) {
  const cardUrl = agentCardUrl(record);
  return (
    <div className="stack">
      <div className="row between">
        <h3>{record.name ?? "Unnamed agent"}</h3>
        <div className="row" style={{ gap: 6 }}>
          {record.version && <Badge>{record.version}</Badge>}
          <Badge tone="accent">
            {isRegistrationRecord(record) ? "ERC-8004 registration record" : "agent card"}
          </Badge>
        </div>
      </div>
      {record.description && <p>{record.description}</p>}

      {record.services && record.services.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {record.services.map((s, i) => (
              <tr key={s.endpoint ?? i}>
                <td>{s.name ?? "unnamed"}</td>
                <td>
                  {s.endpoint ? (
                    <a href={s.endpoint} target="_blank" rel="noreferrer">
                      {s.endpoint}
                    </a>
                  ) : (
                    <span className="muted small">none given</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {record.skills && record.skills.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Skill</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            {record.skills.map((s, i) => (
              <tr key={s.id ?? i}>
                <td>{s.name ?? s.id}</td>
                <td>{s.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isRegistrationRecord(record) && cardUrl && (
        <p className="muted">
          The skills live in the agent card behind that endpoint, not on chain. The record says where to reach
          the agent; the card says what it does.
        </p>
      )}

      {record.registrations && record.registrations.length > 0 && (
        <p className="muted">
          The record names agent {String(record.registrations[0]?.agentId)} on this registry, so the two point at
          each other.
        </p>
      )}
    </div>
  );
}
