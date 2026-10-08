import type { AttemptLogEvent } from './types.js';

export const MAX_ATTEMPT_LOG_EVENTS = 4000;

/**
 * Append firehose events once. Sequence numbers only grow, so anything at or
 * below the newest kept event is a reconnect replay or out-of-order duplicate.
 * The array is capped so a tab left open on a long run stays bounded.
 */
export function appendAttemptLogEvents({ current, additions }: { current: AttemptLogEvent[]; additions: readonly AttemptLogEvent[] }): AttemptLogEvent[] {
  let lastSeq = current.at(-1)?.seq ?? -Infinity;
  const newEvents: AttemptLogEvent[] = [];
  for (const event of additions) {
    if (event.seq <= lastSeq) continue;
    newEvents.push(event);
    lastSeq = event.seq;
  }
  if (newEvents.length === 0) return current;
  const combined = [...current, ...newEvents];
  return combined.length > MAX_ATTEMPT_LOG_EVENTS ? combined.slice(combined.length - MAX_ATTEMPT_LOG_EVENTS) : combined;
}

/** The last live-firehose sequence the page has already applied. */
export function attemptLogCursor({ events }: { events: readonly AttemptLogEvent[] }): number {
  return events.reduce((latest, event) => (event.attemptId === undefined ? latest : Math.max(latest, event.seq)), 0);
}

/** Live updates at or before the REST snapshot are already represented there. */
export function eventsAfterLiveCursor({ events, liveCursor }: { events: readonly AttemptLogEvent[]; liveCursor: number }): AttemptLogEvent[] {
  return events.filter((event) => event.seq > liveCursor);
}

/** Buffered verifier output is transient, so REST hydration cannot contain it. */
export function eventsForAttemptLogHydration({ events, liveCursor }: { events: readonly AttemptLogEvent[]; liveCursor: number }): AttemptLogEvent[] {
  return events.filter((event) => {
    const payload = event.payload as { sessionUpdate?: unknown } | null;
    return event.seq > liveCursor || payload?.sessionUpdate === 'verification_output';
  });
}
