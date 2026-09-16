import type { ReactNode } from "react";

export function Card({ title, children, hint }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title && <h3>{title}</h3>}
      {hint && <p className="hint">{hint}</p>}
      {children}
    </div>
  );
}
