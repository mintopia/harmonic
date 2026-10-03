import { useSyncExternalStore } from 'react';

export type MatchMediaWindow = Pick<Window, 'matchMedia'>;

function railQuery(): string {
  return `(min-width: ${getComputedStyle(document.documentElement).getPropertyValue('--breakpoint-rail').trim()})`;
}

export function isRailLayout(win: Partial<MatchMediaWindow> = window): boolean {
  return win.matchMedia?.(railQuery()).matches ?? true;
}

export function useRailBreakpoint(win: MatchMediaWindow = window): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = win.matchMedia(railQuery());
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => win.matchMedia(railQuery()).matches,
  );
}
