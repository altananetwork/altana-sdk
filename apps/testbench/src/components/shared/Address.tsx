import { useState } from "react";
import { shortAddress } from "../../lib/format";

/** An address or hash in Inter Tight with tabular numbers, optional link and copy. */
export function Address({ value, href, short = true }: { value: string; href?: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = short ? shortAddress(value) : value;
  const inner = <span className="addr" title={value}>{text}</span>;
  return (
    <span className="row" style={{ gap: 4 }}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {inner}
        </a>
      ) : (
        inner
      )}
      <button
        type="button"
        className="btn btn-ghost small"
        aria-label={`Copy ${text}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            /* clipboard unavailable */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
