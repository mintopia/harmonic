import { Fragment, type ReactNode } from 'react';

export interface Crumb {
  node: ReactNode;
  onClick?: () => void;
}

/**
 * The shared breadcrumb bar (the mockup's `.crumbbar`) — one component for the
 * Board home and the Ticket page so the two never drift. A crumb with `onClick`
 * renders as a button (back navigation); the last crumb is plain text. An
 * optional `right` node is pinned to the bar's trailing edge for a page-level
 * action (e.g. the Board's tracker refresh) so it reads as header chrome
 * rather than floating above the content.
 */
export function CrumbBar({
  crumbs,
  right,
  className = '',
}: {
  crumbs: Crumb[];
  right?: ReactNode;
  className?: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline bg-shell px-6 text-[13px] text-muted ${className}`}
    >
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span aria-hidden="true" className="text-edge">
              /
            </span>
          )}
          {c.onClick ? (
            <button type="button" onClick={c.onClick} className="inline-flex items-center gap-[7px] hover:underline">
              {c.node}
            </button>
          ) : (
            <span className="inline-flex items-center gap-[7px]">{c.node}</span>
          )}
        </Fragment>
      ))}
      {right && <div className="ml-auto flex items-center">{right}</div>}
    </nav>
  );
}
