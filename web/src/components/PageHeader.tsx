import type { ReactNode } from 'react';
import { displayTitle } from '../ui';

/**
 * The one page-header shape every top-level surface shares: a title, a single
 * operator-voice description line, and an optional right-side slot for the
 * page's own counts and controls. Keeps titles and descriptions consistent in
 * styling, formatting, and voice across the app.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 ${className ?? ''}`}>
      <div className="min-w-0">
        <h1 className={displayTitle}>{title}</h1>
        <p className="mt-1 max-w-[68ch] text-small text-muted">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
