import type { SessionLeg } from "@altananetwork/sdk";
import { networkByChainId } from "@altananetwork/sdk";
import { txUrl } from "../../lib/explorer";
import { Address } from "./Address";
import { Badge } from "./Badge";

export function LegsTable({ legs }: { legs: readonly SessionLeg[] }) {
  if (legs.length === 0) return <p className="muted">No legs.</p>;
  return (
    <table className="table" aria-label="Legs">
      <thead>
        <tr>
          <th>Chain</th>
          <th>Leg</th>
          <th>Status</th>
          <th>Via</th>
          <th>Transaction</th>
        </tr>
      </thead>
      <tbody>
        {legs.map((l, i) => (
          <tr key={`${l.chainId}-${l.kind}-${i}`}>
            <td>{networkByChainId(l.chainId)?.chain.name ?? l.chainId}</td>
            <td>{l.kind}</td>
            <td>
              <Badge tone={l.status === "CONFIRMED" ? "success" : l.status === "FAILED" ? "error" : undefined}>{l.status}</Badge>
              {l.reason && <div className="muted small">{l.reason}</div>}
            </td>
            <td className="muted">{l.via ?? ""}</td>
            <td>{l.transactionHash ? <Address value={l.transactionHash} href={txUrl(l.chainId, l.transactionHash)} /> : <span className="muted">none</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
