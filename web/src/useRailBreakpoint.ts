import { useSyncExternalStore } from 'react';

export type MatchMediaWindow = Pick<Window, 'matchMedia'>;

const FALLBACK_RAIL_BREAKPOINT = '900px';

let railQueryCache: string | null = null;

function railQuery(): string {
  if (railQueryCache === null) {
    const width = getComputedStyle(document.documentElement).getPropertyValue('--breakpoint-rail').trim();
    railQueryCache = `(min-width: ${width || FALLBACK_RAIL_BREAKPOINT})`;
  }
  return railQueryCache;
}

export function isRailLayout(win: Partial<MatchMediaWindow> = window): boolean {
  return win.matchMedia?.(railQuery()).matches ?? true;
}

export function useRailBreakpoint(win: MatchMediaWindow = window): boolean {
  const query = railQuery();
  return useSyncExternalStore(
    (onChange) => {
      const mq = win.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => win.matchMedia(query).matches,
  );
}
