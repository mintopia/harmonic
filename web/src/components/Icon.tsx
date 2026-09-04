import type { JSX } from 'react';

export type IconName =
  | 'board'
  | 'activity'
  | 'operations'
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
  | 'branch'
  | 'alert-triangle'
  | 'user'
  | 'help';

const PATHS: Record<IconName, JSX.Element> = {
  board: (
    <>
      <rect height="7" rx="1" width="3.5" x="1.75" y="2.75" />
      <rect height="10.5" rx="1" width="3.5" x="6.25" y="2.75" />
      <rect height="5" rx="1" width="3.5" x="10.75" y="2.75" />
    </>
  ),
  activity: <path d="M1.5 8h3l1.75-4 2.5 8 1.75-4H14.5" />,
  operations: (
    <>
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="12" cy="4" r="1.5" />
      <circle cx="8" cy="12" r="1.5" />
      <path d="M5.25 5.25 7 10.5M10.75 5.25 9 10.5M5.5 4h5" />
    </>
  ),
  table: (
    <>
      <rect height="9.5" rx="1" width="12.5" x="1.75" y="3.25" />
      <path d="M1.75 6.5h12.5M1.75 9.75h12.5" />
    </>
  ),
  graph: (
    <>
      <path d="M5 8 11 4.25M5 8 11 11.75" />
      <circle cx="3.25" cy="8" r="1.75" />
      <circle cx="12.75" cy="4" r="1.75" />
      <circle cx="12.75" cy="12" r="1.75" />
    </>
  ),
  stats: <path d="M4.5 13.5V9M8 13.5V3.5M11.5 13.5V7" />,
  api: <path d="M6 4.5 2.5 8l3.5 3.5M10 4.5 13.5 8l-3.5 3.5" />,
  settings: (
    <path d="M9.8 4.2a0.7 0.7 0 0 0 0 0.95l1.05 1.05a0.7 0.7 0 0 0 0.95 0l2.5-2.5a4 4 0 0 1-5.3 5.3l-4.6 4.6a1.4 1.4 0 0 1-2-2l4.6-4.6a4 4 0 0 1 5.3-5.3z" />
  ),
  workspace: (
    <>
      <path d="M12.59 6.77L14.34 7.11L14.34 8.89L12.59 9.23L12.11 10.38L13.11 11.85L11.85 13.11L10.38 12.11L9.23 12.59L8.89 14.34L7.11 14.34L6.77 12.59L5.63 12.11L4.15 13.11L2.89 11.85L3.89 10.38L3.41 9.23L1.66 8.89L1.66 7.11L3.41 6.77L3.89 5.63L2.89 4.15L4.15 2.89L5.62 3.89L6.77 3.41L7.11 1.66L8.89 1.66L9.23 3.41L10.38 3.89L11.85 2.89L13.11 4.15L12.11 5.62Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  logout: (
    <>
      <path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3" />
      <path d="M10.5 5.5 13 8l-2.5 2.5M13 8H6" />
    </>
  ),
  'chevrons-left': <path d="M8 4.5 4.5 8 8 11.5M12 4.5 8.5 8l3.5 3.5" />,
  'chevron-down': <path d="M4.5 6.25 8 9.75l3.5-3.5" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1" />
    </>
  ),
  moon: <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3a5.4 5.4 0 1 0 6.6 6.6Z" />,
  'circle-half': (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25v11.5" />
    </>
  ),
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  close: <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />,
  chat: <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />,
  send: <path d="M2.5 8 13.5 2.5 9.5 13.5 7.5 9 2.5 8Z" />,
  'arrow-left': <path d="M12.5 8h-9M7 3.5 2.5 8 7 12.5" />,
  edit: (
    <>
      <path d="M10 3 13 6l-7.5 7.5H2.5V10Z" />
      <path d="M8.5 4.5 11.5 7.5" />
    </>
  ),
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  expand: (
    <>
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 9 7" />
      <path d="M6.5 13.5h-4v-4" />
      <path d="M2.5 13.5 7 9" />
    </>
  ),
  collapse: (
    <>
      <path d="M6.5 6.5h-4v-4" />
      <path d="M2.5 2.5 7 7" />
      <path d="M9.5 9.5h4v4" />
      <path d="M13.5 13.5 9 9" />
    </>
  ),
  refresh: (
    <>
      <path d="M12.75 8a4.75 4.75 0 1 1-1.4-3.36" />
      <path d="M12.75 2.5V5H10.25" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.75" r="1.6" />
      <path d="M4.5 5.35v6.9" />
      <rect height="3.2" rx="1" width="3.2" x="9.9" y="9.05" />
      <path d="M4.5 10h4.1a1.8 1.8 0 0 0 1.8-1.8V6.4" />
    </>
  ),
  'alert-triangle': (
    <>
      <path d="M8 2.25 14.5 13.5H1.5Z" />
      <path d="M8 6.25v3.25" />
      <path d="M8 11.75v.01" />
    </>
  ),
  user: (
    <>
      <circle cx="8" cy="5.25" r="2.75" />
      <path d="M2.75 14.25a5.25 5.25 0 0 1 10.5 0" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.9 6.1a2.1 2.1 0 1 1 3.15 1.82c-.7.42-1.05.86-1.05 1.68" />
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
