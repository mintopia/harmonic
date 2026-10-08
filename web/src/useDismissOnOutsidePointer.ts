import { useEffect, useRef, type RefObject } from 'react';

export function useDismissOnOutsidePointer(ref: RefObject<HTMLElement | null>, open: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  useEffect(() => {
    latest.current = dismiss;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) latest.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [ref, open]);
}
