import { useState } from 'react';
import { subscribeCriticLog } from '../ws';
import { useLiveEffect } from '../useLiveEffect';
import { appendAttemptLogEvents } from '../attempt-log-stream-model';
import type { AttemptLogEvent } from '../types';

/** The running critic's own live ACP transcript, streamed on the critic channel
 * keyed by the builder Attempt. Unlike {@link useAttemptLogStream} there is no
 * REST snapshot — the running critic has no persisted transcript yet — so the
 * bus buffer is replayed on subscribe and the cursor advances from there. */
export function useCriticLiveStream(attemptId: number | null): AttemptLogEvent[] {
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);

  useLiveEffect(() => {
    if (attemptId === null) return;
    let cursor = 0;
    setEvents([]);
    const unsubscribe = subscribeCriticLog({
      attemptId,
      after: () => cursor,
      onEvent: (event) => {
        cursor = Math.max(cursor, event.seq);
        setEvents((current) => appendAttemptLogEvents({ current, additions: [event] }));
      },
    });
    return unsubscribe;
  }, [attemptId]);

  return events;
}
