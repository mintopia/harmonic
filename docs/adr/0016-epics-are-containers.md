# Decision: Epics are label-driven containers, not work tasks

Status: accepted
Date: 2026-08-31

## Context

ADR-0004 mirrors each tracker issue 1:1 into a Task. Only `wayfinder:map`
tickets are treated as containers (derived, never mirrored); every other
ticket — including a **spec epic**, a parent ticket that groups child work — is
mirrored as an ordinary, runnable work Task.

That is wrong. An epic is a container, "not directly runnable" — the tracker's
own `epic` label says exactly this. Mirroring an epic as a work card has a
sharp, load-bearing failure mode:

- The epic shows up on the Board as a runnable card. Deleting it (a natural
  cleanup — an epic isn't work) writes a dismissal tombstone, which permanently
  stops the next poll from re-mirroring it.
- Because the epic is not a `wayfinder:map`, it is never persisted to
  `tracker_containers` either. So it exists in neither table.
- `deriveEpics` resolves an epic from the persisted ticket set; with the epic in
  neither table it hits the dangling-parent branch and is never derived. Every
  still-open child is then orphaned from its epic on the Board.

Observed live: epic #408 ("Epic summary page (ADR-0015)"), carrying the `epic`
label, was mirrored as a work Task, deleted, and its five open `ready` children
(#409–#413) lost their epic grouping. The mirror ignored the `epic` label
entirely — it only special-cases `wayfinder:map`.

ADR-0015 further assumed epics surface in the Tasks list via an `isEpic` flag on
the mirrored **task** row — which presumes an epic is a task.

## Decision

An epic is a **container**, never a runnable work Task.

- **Container identification (mirror).** A tracker ticket is a container when it
  carries the `epic` label or `wayfinder:map`. The mirror persists it to
  `tracker_containers` and does **not** mirror it as a work Task. Container
  tickets are re-derived from the label + structure every poll, so they are
  immune to the work-Task delete/tombstone path.
- **The epic (top-level).** The epic surfaced on the Board and as a Tasks-list
  row is a container with **no parent of its own**. A container that itself has
  a parent is a nested sub-container: also non-runnable, its leaves rolling up to
  the top-level epic rather than standing alone.
- **One source of truth.** Epics are read from the derived-epic model
  (`deriveEpics` / `listEpics`), not from a mirrored task row. The Tasks list,
  Board grouping, and Graph all read the same derived epics; the Tasks list
  renders an epic as an epic-format row (the row work already done stays).

## Consequences

- Fixes the child-orphaning bug for open epics (#408 today, and the whole class).
- The `epic` label becomes load-bearing tracker metadata: a ticket that groups
  work must carry `epic` (or be a `wayfinder:map`).
- Existing epic Tasks (~26 rows on the live instance) must be **demoted** to
  containers by a non-tombstoning migration — distinct from the operator Delete
  path, which must keep its dismissal semantics for real work Tasks.
- #408's stale `tracker_dismissals` row is cleared so it re-derives as a
  container.
- Nested epics (epic → sub-epic → leaves) collapse to a single top-level epic for
  grouping; member rollup is over leaf descendants. Only closed/historical data
  currently nests; the one open epic is flat.
- The Tasks-list / Graph epic entry points move from `isEpic` task rows to the
  derived model. The epic **row format** is unchanged.

## Supersedes

None wholesale. Refines 0004-tracker-mirroring-and-ticket-sourcing.md (containers
are label-driven, not map-only) and the epic-surfacing entry point of
0015-epic-summary-page.md (epics come from the derived model, not `isEpic` task
rows).
