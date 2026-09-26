import { useEffect, useState } from 'react';
import { getConnectionState, subscribeConnectionState } from '../ws';

/** A slim top banner while the firehose socket is down or retrying. Delayed
 * so a sub-second reconnect (a tab wake, a brief network blip) never flashes
 * it — only a drop the operator would actually notice. */
export function ConnectionBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      if (getConnectionState() === 'connected') {
        if (timer) clearTimeout(timer);
        timer = null;
        setVisible(false);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => setVisible(true), 2000);
    };
    evaluate();
    const unsubscribe = subscribeConnectionState(evaluate);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;
  // Fixed, not in-flow: the app shell is a flex row at the desktop breakpoint,
  // so an in-flow banner here would become a sidebar-height column instead of
  // a top bar.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-running-tint px-3 py-1.5 text-small text-running shadow-bar"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-running-dot motion-reduce:animate-none" />
      Reconnecting to Harmonic — the view may be out of date.
    </div>
  );
}
