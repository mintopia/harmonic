import type { TrackerRef } from './types.js';

/** A task id in a compact identifier slot (Deck row, graph node, table cell): `T-174`. */
export function taskKey(id: number): string {
  return `T-${id}`;
}

/** A task id in prose or a dialog title: `Task 174` (never `Task #174`). */
export function taskLabel(id: number): string {
  return `Task ${id}`;
}

/** An epic ref in prose or a title: `Epic #42`. */
export function epicLabel(ref: TrackerRef): string {
  return `Epic ${issueRef(ref)}`;
}

/**
 * A tracker issue ref as its adapter renders it (ADR-0046): numeric refs
 * (GitHub, GitLab, Forgejo) get `#185`; key-style refs (Jira `PROJ-185`,
 * Forgejo `milestone-3`) are shown as-is. The only place a bare `#n` is legitimate.
 */
export function issueRef(ref: TrackerRef): string {
  return /^\d+$/.test(ref) ? `#${ref}` : ref;
}

/**
 * The dual identity shown where both spaces meet — the Ticket header of a
 * mirrored Task: `Task 174 · issue #185`. A native Task (no tracker ref) shows
 * just its task label.
 */
export function ticketIdentity(id: number, trackerRef: TrackerRef | null | undefined): string {
  return trackerRef != null ? `${taskLabel(id)} · issue ${issueRef(trackerRef)}` : taskLabel(id);
}

/**
 * The compact dual identity for a ticket in a listing — a Board card, a Table or
 * Graph row, an Epic child: `#185 · T-174`. Tracker ref first (the number triagers
 * cross-reference), then the task key. A native Task (no tracker ref) shows just
 * its `T-` key. Keeps every listing surface labelling a ticket the same way.
 */
export function ticketRowId(id: number, trackerRef: TrackerRef | null | undefined): string {
  return trackerRef != null ? `${issueRef(trackerRef)} · ${taskKey(id)}` : taskKey(id);
}

export function eventCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'event' : 'events'}`;
}
