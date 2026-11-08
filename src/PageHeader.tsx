import type { ReactNode } from 'react';

/** The title row used at the top of every page (same markup as the Transfer page). */
export default function PageHeader({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) {
  return (
    <header className={`topbar${children ? ' topbar--with-actions' : ''}`}>
      <div>
        {/* tabIndex -1: focus moves here when you switch pages, for screen readers. */}
        <h1 tabIndex={-1}>{title}</h1>
        <p className="topbar-sub">{subtitle}</p>
      </div>
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}
