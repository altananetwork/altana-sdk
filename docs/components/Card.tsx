import type { ReactNode } from "react";

/**
 * Link cards used on the homepage and overview pages.
 * Styling lives in styles.css (.altana-card, .altana-card-grid).
 */
export function CardGrid({
  columns = 3,
  children,
}: {
  columns?: 2 | 3;
  children: ReactNode;
}) {
  return (
    <div className={columns === 2 ? "altana-card-grid cols-2" : "altana-card-grid"}>
      {children}
    </div>
  );
}

export function Card({
  href,
  icon,
  title,
  cta,
  children,
}: {
  href: string;
  icon?: ReactNode;
  title: string;
  cta?: string;
  children?: ReactNode;
}) {
  return (
    <a href={href} className="altana-card">
      {icon ? <div className="card-icon">{icon}</div> : null}
      <div className="card-title">{title}</div>
      {children ? <div className="card-desc">{children}</div> : null}
      {cta ? <span className="card-cta">{cta}</span> : null}
    </a>
  );
}
