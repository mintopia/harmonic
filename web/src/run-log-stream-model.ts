import type { RunLogEvent } from './types.js';

/**
 * Append firehose events once. The server's transient ids survive a WebSocket
 * reconnect, so keeping them as the identity prevents duplicate rows while
 * preserving the arrival order of new output.
 */
export function appendRunLogEvents(current: RunLogEvent[], additions: readonly RunLogEvent[]): RunLogEvent[] {
  if (additions.length === 0) return current;
  const ids = new Set(current.map((event) => event.id));
  const newEvents = additions.filter((event) => !ids.has(event.id));
  return newEvents.length === 0 ? current : [...current, ...newEvents];
}

/** The last transcript sequence the page has already applied. */
export function runLogCursor(events: readonly RunLogEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.seq), 0);
}
