/**
 * Task ids vs tracker refs — the two number spaces (issue #192).
 *
 * Harmonic has two overlapping integer spaces that used to render the same way
 * and collide: a **task id** (the DB primary key — `finish_task`/`escalate_task`
 * take `taskId`, `GET /api/tasks/:id`) and a **tracker ref** (the GitHub issue
 * number, `trackerRef`). Because the same integer means different things, a bare
 * `#185` was ambiguous.
 *
 * The rule these helpers enforce (and DESIGN.md § 3 documents): a task id is
 * **never** written as a bare `#n` — it carries a `T-`/`Task` prefix — and `#n`
 * is reserved exclusively for a tracker issue, matching GitHub's own convention.
 * Centralised here so every surface writes the two spaces the same way.
 */

/** A task id in a compact identifier slot (Deck row, graph node, table cell): `T-174`. */
export function taskKey(id: number): string {
  return `T-${id}`;
}

/** A task id in prose or a dialog title: `Task 174` (never `Task #174`). */
export function taskLabel(id: number): string {
  return `Task ${id}`;
}

/** A tracker (GitHub) issue ref: `#185`. The only place a bare `#n` is legitimate. */
export function issueRef(ref: number): string {
  return `#${ref}`;
}

/**
 * The dual identity shown where both spaces meet — the Ticket header of a
 * mirrored Task: `Task 174 · issue #185`. A native Task (no tracker ref) shows
 * just its task label.
 */
export function ticketIdentity(id: number, trackerRef: number | null | undefined): string {
  return trackerRef != null ? `${taskLabel(id)} · issue ${issueRef(trackerRef)}` : taskLabel(id);
}
