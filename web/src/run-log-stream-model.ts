import type { RunLogEvent } from './types.js';

/**
 * Append firehose events once. The server's transient ids survive a WebSocket
 * reconnect, so keeping them as the identity prevents duplicate rows while
 * preserving the arrival order of new output.
 */
export function appendRunLogEvents({ current, additions }: { current: RunLogEvent[]; additions: readonly RunLogEvent[] }): RunLogEvent[] {
  if (additions.length === 0) return current;
  const ids = new Set(current.map((event) => event.id));
  const newEvents = additions.filter((event) => !ids.has(event.id));
  return newEvents.length === 0 ? current : [...current, ...newEvents];
}

/** The last live-firehose sequence the page has already applied. */
export function runLogCursor({ events }: { events: readonly RunLogEvent[] }): number {
  return events.reduce((latest, event) => (event.runId === undefined ? latest : Math.max(latest, event.seq)), 0);
}

/** Live updates at or before the REST snapshot are already represented there. */
export function eventsAfterLiveCursor({ events, liveCursor }: { events: readonly RunLogEvent[]; liveCursor: number }): RunLogEvent[] {
  return events.filter((event) => event.seq > liveCursor);
}
