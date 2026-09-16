import { stringify } from "../lib/log";
import { useApp } from "../state/AppState";
import { Button } from "./shared/Button";

export function ActivityLogPanel() {
  const { state, dispatch } = useApp();
  const text = state.log
    .map((e) => `${e.time} ${e.method}${e.error ? ` ERROR ${e.error}` : ""}\n${stringify(e.args)}\n${e.result !== undefined ? stringify(e.result) : ""}`)
    .join("\n\n");
  return (
    <div className="panel">
      <div className="row between">
        <h2>Activity</h2>
        <div className="row">
          <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(text)} disabled={state.log.length === 0}>
            Copy
          </Button>
          <Button variant="ghost" onClick={() => dispatch({ type: "log/clear" })} disabled={state.log.length === 0}>
            Clear
          </Button>
        </div>
      </div>
      <div className="log" aria-live="polite">
        {state.log.length === 0 && <p className="muted">Every relay call, result and error shows here.</p>}
        {state.log.map((e) => (
          <article key={e.id} className={`log-entry${e.level === "error" ? " error" : ""}`}>
            <div className="head">
              <span>{e.method}</span>
              <span className="time">{e.time}</span>
            </div>
            {e.error && <div className="body">{e.error}</div>}
            {e.args !== undefined && <details><summary className="small muted">arguments</summary><div className="body">{stringify(e.args)}</div></details>}
            {e.result !== undefined && <details><summary className="small muted">result</summary><div className="body">{stringify(e.result)}</div></details>}
          </article>
        ))}
      </div>
    </div>
  );
}
