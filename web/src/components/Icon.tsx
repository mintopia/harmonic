import type { JSX } from 'react';

/**
 * Minimal stroke icon vocabulary for the rail (issue 21): one weight,
 * currentColor line work only — instrumentation, not chat-app art
 * (PRODUCT.md anti-references). Add glyphs here, never emoji or an
 * icon-font dependency.
 */
export type IconName =
  | 'deck'
  | 'activity'
  | 'table'
  | 'graph'
  | 'stats'
  | 'api'
  | 'settings'
  | 'workspace'
  | 'logout'
  | 'chevrons-left'
  | 'chevron-down'
  | 'sun'
  | 'moon'
  | 'circle-half'
  | 'check'
  | 'close'
  | 'chat'
  | 'send'
  | 'arrow-left'
  | 'edit'
  | 'plus'
  | 'expand'
  | 'collapse'
  | 'refresh'
  | 'alert-triangle';

const PATHS: Record<IconName, JSX.Element> = {
  // Kanban columns, top-aligned at differing heights.
  deck: (
    <>
      <rect height="7" rx="1" width="3.5" x="1.75" y="2.75" />
      <rect height="10.5" rx="1" width="3.5" x="6.25" y="2.75" />
      <rect height="5" rx="1" width="3.5" x="10.75" y="2.75" />
    </>
  ),
  // Live pulse waveform: the instance-wide Activity view (issue #52).
  activity: <path d="M1.5 8h3l1.75-4 2.5 8 1.75-4H14.5" />,
  // Row grid.
  table: (
    <>
      <rect height="9.5" rx="1" width="12.5" x="1.75" y="3.25" />
      <path d="M1.75 6.5h12.5M1.75 9.75h12.5" />
    </>
  ),
  // A small dependency DAG (one node fanning out to two): the Graph view.
  graph: (
    <>
      <path d="M5 8 11 4.25M5 8 11 11.75" />
      <circle cx="3.25" cy="8" r="1.75" />
      <circle cx="12.75" cy="4" r="1.75" />
      <circle cx="12.75" cy="12" r="1.75" />
    </>
  ),
  // Bar chart, bottom-aligned.
  stats: <path d="M4.5 13.5V9M8 13.5V3.5M11.5 13.5V7" />,
  // Code brackets: the API surface, not the key — this is a view now, not a modal.
  api: <path d="M6 4.5 2.5 8l3.5 3.5M10 4.5 13.5 8l-3.5 3.5" />,
  // Gear: the config editor.
  settings: (
    <>
      <circle cx="8" cy="8" r="1.8" />
      <path d="M8 2.5v1.6M8 11.9v1.6M13.5 8h-1.6M4.1 8H2.5M11.7 4.3l-1.1 1.1M5.4 10.6l-1.1 1.1M11.7 11.7l-1.1-1.1M5.4 5.4 4.3 4.3" />
    </>
  ),
  // Folder: the per-Workspace settings page (issue #64) — a Workspace is a
  // named Working Directory, so its glyph is the directory it points at.
  workspace: <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1Z" />,
  // Door frame with an outbound arrow.
  logout: (
    <>
      <path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3" />
      <path d="M10.5 5.5 13 8l-2.5 2.5M13 8H6" />
    </>
  ),
  // Rail collapse chevrons; mirror with -scale-x-100 to point right.
  'chevrons-left': <path d="M8 4.5 4.5 8 8 11.5M12 4.5 8.5 8l3.5 3.5" />,
  // Disclosure caret; rotate -90 for the closed state.
  'chevron-down': <path d="M4.5 6.25 8 9.75l3.5-3.5" />,
  // Theme cycle: light.
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1" />
    </>
  ),
  // Theme cycle: dark.
  moon: <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6Z" />,
  // Theme cycle: follow the system (half-and-half).
  'circle-half': (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25v11.5" />
    </>
  ),
  // Selection tick for list options.
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  // Dismiss (toasts, chips).
  close: <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />,
  // Conversation launcher: a speech balloon, not a face — a process, not a
  // persona (PRODUCT.md's chat-app-cuteness anti-reference).
  chat: <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />,
  // Composer submit.
  send: <path d="M2.5 8 13.5 2.5 9.5 13.5 7.5 9 2.5 8Z" />,
  // Detail → list (issue #15's history browsing).
  'arrow-left': <path d="M12.5 8h-9M7 3.5 2.5 8 7 12.5" />,
  // Rename affordance: a plain pencil, no flourish.
  edit: (
    <>
      <path d="M10 3 13 6l-7.5 7.5H2.5V10Z" />
      <path d="M8.5 4.5 11.5 7.5" />
    </>
  ),
  // Add affordance: a plain plus (add-workspace button, issue #66).
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  // Docked panel → full overlay: outward corner arrows (issue #15).
  expand: (
    <>
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 9 7" />
      <path d="M6.5 13.5h-4v-4" />
      <path d="M2.5 13.5 7 9" />
    </>
  ),
  // Overlay → docked panel: the same arrows, pointing inward.
  collapse: (
    <>
      <path d="M6.5 6.5h-4v-4" />
      <path d="M2.5 2.5 7 7" />
      <path d="M9.5 9.5h4v4" />
      <path d="M13.5 13.5 9 9" />
    </>
  ),
  // Circular arrow: force a re-poll of the tracker (the deck's manual refresh).
  refresh: (
    <>
      <path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36" />
      <path d="M12.75 2.5V5H10.25" />
    </>
  ),
  // Alert triangle: the "needs a human look" signal (issue #174) — an
  // inconclusive verdict / escalate outcome, so it reads without relying on
  // colour alone (colourblind safety). The "!" is drawn stroke-only (a short
  // bar plus a zero-length round-capped dot) to stay one weight, matching
  // every other glyph in this file rather than introducing a filled dot.
  'alert-triangle': (
    <>
      <path d="M8 2.25 14.5 13.5H1.5Z" />
      <path d="M8 6.25v3.25" />
      <path d="M8 11.75v.01" />
    </>
  ),
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
