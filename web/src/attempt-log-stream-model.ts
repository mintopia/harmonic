import type { AttemptLogEvent } from './types.js';

/**
 * Append firehose events once. The server's transient ids survive a WebSocket
 * reconnect, so keeping them as the identity prevents duplicate rows while
 * preserving the arrival order of new output.
 */
export function appendAttemptLogEvents({ current, additions }: { current: AttemptLogEvent[]; additions: readonly AttemptLogEvent[] }): AttemptLogEvent[] {
  if (additions.length === 0) return current;
  const ids = new Set(current.map((event) => event.id));
  const newEvents = additions.filter((event) => !ids.has(event.id));
  return newEvents.length === 0 ? current : [...current, ...newEvents];
}

/** The last live-firehose sequence the page has already applied. */
export function attemptLogCursor({ events }: { events: readonly AttemptLogEvent[] }): number {
  return events.reduce((latest, event) => (event.attemptId === undefined ? latest : Math.max(latest, event.seq)), 0);
}

/** Live updates at or before the REST snapshot are already represented there. */
export function eventsAfterLiveCursor({ events, liveCursor }: { events: readonly AttemptLogEvent[]; liveCursor: number }): AttemptLogEvent[] {
  return events.filter((event) => event.seq > liveCursor);
}
