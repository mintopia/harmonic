import { useState } from 'react';
import { api } from '../api';
import { subscribeAttemptLog } from '../ws';
import { useLiveEffect } from '../useLiveEffect';
import { appendAttemptLogEvents, eventsAfterLiveCursor, attemptLogCursor } from '../attempt-log-stream-model';
import { toastError } from '../toast';
import type { AttemptLogEvent } from '../types';

/** The selected Attempt's session log, reconciling the REST snapshot with the
 * live stream. Owns the cursor/buffer/cutover: it subscribes before hydrating
 * but skips the stream's own replay (the REST snapshot already holds it, in a
 * different id space); events arriving mid-hydration are buffered and cut over
 * at the snapshot's live cursor. Null attemptId leaves the last log in place —
 * the panel only renders for a selected Attempt. */
export function useAttemptLogStream(attemptId: number | null): {
  events: AttemptLogEvent[];
  logUnavailable: boolean;
} {
  const [events, setEvents] = useState<AttemptLogEvent[]>([]);
  const [logUnavailable, setLogUnavailable] = useState(false);

  useLiveEffect((live) => {
    if (attemptId === null) return;
    let hydrated = false;
    const pending: AttemptLogEvent[] = [];
    let cursor = 0;
    setEvents([]);
    setLogUnavailable(false);
    const unsubscribe = subscribeAttemptLog({ attemptId, after: () => cursor, onEvent: (event) => {
      cursor = Math.max(cursor, event.seq);
      if (!hydrated) {
        pending.push(event);
        return;
      }
      setEvents((current) => appendAttemptLogEvents({ current, additions: [event] }));
    } });
    api.attemptLog(attemptId).then(
      (log) => {
        if (!live()) return;
        setLogUnavailable(log.status === 'unavailable');
        const hydratedEvents = appendAttemptLogEvents({
          current: log.status === 'available' ? log.events : [],
          additions: log.status === 'available' ? eventsAfterLiveCursor({ events: pending, liveCursor: log.liveCursor }) : pending,
        });
        cursor = Math.max(log.liveCursor, attemptLogCursor({ events: pending }));
        setEvents(hydratedEvents);
        hydrated = true;
      },
      (error: unknown) => {
        if (!live()) return;
        const hydratedEvents = appendAttemptLogEvents({ current: [], additions: pending });
        cursor = attemptLogCursor({ events: pending });
        setEvents(hydratedEvents);
        hydrated = true;
        toastError(error);
      },
    );
    return () => {
      unsubscribe();
    };
  }, [attemptId]);

  return { events, logUnavailable };
}
