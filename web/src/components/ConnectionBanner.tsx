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
  // In-flow, in App.tsx's own flex-col wrapper outside the rail:flex-row shell,
  // so it takes its own row and pushes the shell down instead of covering it.
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center justify-center gap-2 bg-running-tint px-3 py-1.5 text-small text-running"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 animate-pulse rounded-full bg-running-dot motion-reduce:animate-none" />
      Reconnecting to Harmonic — the view may be out of date.
    </div>
  );
}
