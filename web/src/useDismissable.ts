import { useEffect, useRef, type RefObject } from 'react';

export type DismissReason = 'escape' | 'outside';

export function useDismissable(open: boolean, ref: RefObject<HTMLElement | null>, onDismiss: (reason: DismissReason) => void): void {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismissRef.current('outside');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismissRef.current('escape');
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref]);
}
