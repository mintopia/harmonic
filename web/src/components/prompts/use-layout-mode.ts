import { useLayoutEffect, useState, type RefObject } from 'react';

export type LayoutMode = 'wide' | 'medium' | 'narrow';

const WIDE_PX = 1024;
const MEDIUM_PX = 704;

/** An unmeasured (zero-width) panel counts as wide so the full layout renders before the first measurement. */
export function layoutModeFor(widthPx: number): LayoutMode {
  if (widthPx <= 0 || widthPx >= WIDE_PX) return 'wide';
  return widthPx >= MEDIUM_PX ? 'medium' : 'narrow';
}

export function useLayoutMode(ref: RefObject<HTMLElement | null>): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>('wide');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setMode(layoutModeFor(el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return mode;
}
