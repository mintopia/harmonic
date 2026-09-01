import { useEffect, useState } from 'react';
import { subscribe } from '../ws';
import type { AttemptUsageEvent } from '../types';

/** Live token/cost deltas for the in-flight Attempt (the `attempt_usage`
 * firehose, ~1s) — `attempt_changed` only merges at Step transitions, so
 * without this the metric row holds the stale settled figures while the
 * Attempt is executing. Keyed by attempt id. */
export function useLiveUsage(): Map<number, AttemptUsageEvent> {
  const [liveUsage, setLiveUsage] = useState<Map<number, AttemptUsageEvent>>(() => new Map());
  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type !== 'attempt_usage') return;
        setLiveUsage((prev) => new Map(prev).set(msg.attemptId, msg));
      }),
    [],
  );
  return liveUsage;
}
