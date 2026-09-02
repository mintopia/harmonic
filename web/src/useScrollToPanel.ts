import { useEffect, useRef, type RefObject } from 'react';

/**
 * Re-home a detail page's scroll when its rail selection changes: with a panel
 * picked, scroll the content panel into view — retrying as the panel's content
 * loads, since on a deep link the panel is still empty when the effect first
 * fires and there is nothing to scroll to yet; with nothing picked, start at
 * the page header.
 */
export function useScrollToPanel(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  picked: boolean,
  key: unknown,
): void {
  const pickedRef = useRef(picked);
  useEffect(() => {
    pickedRef.current = picked;
  });
  useEffect(() => {
    const scroller = scrollRef.current;
    const target = contentRef.current;
    if (!scroller || !target) return;
    if (!pickedRef.current) {
      scroller.scrollTop = 0;
      return;
    }
    let settled = false;
    const attempt = () => {
      if (settled) return;
      target.scrollIntoView({ block: 'start' });
      if (scroller.scrollTop > 0) settled = true;
    };
    attempt();
    const observer = new ResizeObserver(attempt);
    observer.observe(target);
    const stop = window.setTimeout(() => {
      settled = true;
      observer.disconnect();
    }, 20_000);
    return () => {
      window.clearTimeout(stop);
      observer.disconnect();
    };
  }, [key, scrollRef, contentRef]);
}
