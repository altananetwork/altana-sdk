import type { ReactNode } from "react";

export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
}: {
  label: string;
  help?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help && !error && <span className="help">{help}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
