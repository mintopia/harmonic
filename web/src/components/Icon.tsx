import type { JSX } from 'react';

/**
 * Minimal stroke icon vocabulary for the rail (issue 21): one weight,
 * currentColor line work only — instrumentation, not chat-app art
 * (PRODUCT.md anti-references). Add glyphs here, never emoji or an
 * icon-font dependency.
 */
export type IconName =
  | 'board'
  | 'table'
  | 'stats'
  | 'channels'
  | 'api'
  | 'settings'
  | 'logout'
  | 'chevrons-left';

const PATHS: Record<IconName, JSX.Element> = {
  // Kanban columns, top-aligned at differing heights.
  board: (
    <>
      <rect height="7" rx="1" width="3.5" x="1.75" y="2.75" />
      <rect height="10.5" rx="1" width="3.5" x="6.25" y="2.75" />
      <rect height="5" rx="1" width="3.5" x="10.75" y="2.75" />
    </>
  ),
  // Row grid.
  table: (
    <>
      <rect height="9.5" rx="1" width="12.5" x="1.75" y="3.25" />
      <path d="M1.75 6.5h12.5M1.75 9.75h12.5" />
    </>
  ),
  // Bar chart, bottom-aligned.
  stats: <path d="M4.5 13.5V9M8 13.5V3.5M11.5 13.5V7" />,
  // Broadcast: source dot between two waves.
  channels: (
    <>
      <circle cx="8" cy="8" fill="currentColor" r="1.4" stroke="none" />
      <path d="M4.6 11.4a4.8 4.8 0 0 1 0-6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" />
    </>
  ),
  // Code brackets: the API surface, not the key — this is a view now, not a modal.
  api: <path d="M6 4.5 2.5 8l3.5 3.5M10 4.5 13.5 8l-3.5 3.5" />,
  // Gear: the config editor.
  settings: (
    <>
      <circle cx="8" cy="8" r="1.8" />
      <path d="M8 2.5v1.6M8 11.9v1.6M13.5 8h-1.6M4.1 8H2.5M11.7 4.3l-1.1 1.1M5.4 10.6l-1.1 1.1M11.7 11.7l-1.1-1.1M5.4 5.4 4.3 4.3" />
    </>
  ),
  // Door frame with an outbound arrow.
  logout: (
    <>
      <path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3" />
      <path d="M10.5 5.5 13 8l-2.5 2.5M13 8H6" />
    </>
  ),
  // Rail collapse chevrons; mirror with -scale-x-100 to point right.
  'chevrons-left': <path d="M8 4.5 4.5 8 8 11.5M12 4.5 8.5 8l3.5 3.5" />,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="16"
    >
      {PATHS[name]}
    </svg>
  );
}
