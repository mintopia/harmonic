import type { RunLogEvent } from './types.js';

/**
 * Append firehose events once. The server's transient ids survive a WebSocket
 * reconnect and the native transcript share their Run-local sequence, which
 * lets hydration discard an overlapping live update without collapsing real
 * repeated output.
 */
export function appendRunLogEvents(current: RunLogEvent[], additions: readonly RunLogEvent[]): RunLogEvent[] {
  if (additions.length === 0) return current;
  const sequences = new Set(current.map((event) => event.seq));
  const newEvents = additions.filter((event) => !sequences.has(event.seq));
  return newEvents.length === 0 ? current : [...current, ...newEvents];
}

/** The last transcript sequence the page has already applied. */
export function runLogCursor(events: readonly RunLogEvent[]): number {
  return events.reduce((latest, event) => Math.max(latest, event.seq), 0);
}
