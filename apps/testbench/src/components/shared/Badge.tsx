import type { ReactNode } from "react";

export function Badge({ tone, children }: { tone?: "success" | "warning" | "accent" | "error"; children: ReactNode }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}`}>{children}</span>;
}
