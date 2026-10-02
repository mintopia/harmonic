# Decision: Epics are label-driven containers, not work tasks

Status: accepted
Date: 2026-08-31
Reconciled: 2026-10-02. Amended by ADR-0018 (storage), ADR-0023 (structural roots), and ADR-0028 (Epic Attempts).

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

An Epic is a **container**, never an ordinary runnable work Task. It can
run Epic Verification and corrective Attempts under ADR-0028.

- **Container identification (mirror).** A tracker ticket is a container when it
  carries the `epic` label or `wayfinder:map`, or is an unlabelled root with
  children (ADR-0023). The mirror persists it to
  `tracker_containers` and does **not** mirror it as a work Task. Container
  tickets are re-derived from the label + structure every poll, so they are
  immune to the work-Task delete/tombstone path.
- **Integration unit.** ADR-0018 replaced top-level rollup with durable
  leaf-most Epics. Nested container structure is retained to determine the
  appropriate integration unit, rather than making a container a work Task.
- **One source of truth.** Stored `epics` records enumerate Board, Tasks-list,
  and Graph Epics. Membership is derived from tracker structure while available
  and falls back to the retained integration snapshot for history (ADR-0018).

## Consequences

- Fixes the child-orphaning bug for open epics (#408 today, and the whole class).
- Nested containers require `epic` or `wayfinder:map`; structural roots
  with children do not require a label (ADR-0023).
- The original remediation demoted mirrored Epic Tasks without creating
  dismissal tombstones. This was rollout work, not a pending migration.
- ADR-0018 replaced top-level rollup with stored leaf-most integration
  units; member rollup follows that current containment model.
- The Tasks-list / Graph epic entry points move from `isEpic` task rows to the
  derived model. The epic **row format** is unchanged.

## Supersedes

None wholesale. Refines 0004-tracker-mirroring-and-ticket-sourcing.md (containers
are label-driven, not map-only) and the epic-surfacing entry point of
0015-epic-summary-page.md (epics come from the derived model, not `isEpic` task
rows).
