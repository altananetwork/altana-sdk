import { useState } from "react";

/**
 * Copyable block of plain text: a prompt or a shell command the reader is
 * meant to paste somewhere else. Used by the Skills Registry submit flow,
 * which mirrors the one on skills.altana.network.
 *
 * Not a code block. Vocs syntax highlighting owns those; this is for text
 * whose only job is to be copied. Styling lives in styles.css
 * (.altana-copyblock).
 */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context, permissions). Leave the text
      // selectable so the reader can copy it by hand.
    }
  }

  return (
    <div className="altana-copyblock">
      {label ? <div className="copyblock-label">{label}</div> : null}
      <button
        type="button"
        className="copyblock-button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="copyblock-body">{text}</pre>
    </div>
  );
}
