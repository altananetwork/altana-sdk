import type { ReactNode } from "react";

/**
 * Small uppercase section label rendered above a page's H1.
 * Styling lives in styles.css (.altana-eyebrow).
 */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="altana-eyebrow">{children}</p>;
}
