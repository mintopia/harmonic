import { useSyncExternalStore } from 'react';

// Mirrors --breakpoint-rail (index.css): collapsed-only a11y attributes
// must not leak into the mobile drawer, so JS needs the same threshold.
const RAIL_QUERY = '(min-width: 900px)';

export type MatchMediaWindow = Pick<Window, 'matchMedia'>;

export function useRailBreakpoint(win: MatchMediaWindow = window): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = win.matchMedia(RAIL_QUERY);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => win.matchMedia(RAIL_QUERY).matches,
  );
}
