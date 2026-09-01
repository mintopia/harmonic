# Decision: Epic summary page

Status: accepted
Date: 2026-08-31
Refined by: 0016-epics-are-containers.md (epics surface from the derived-epic model, not `isEpic` task rows), 0017-epic-summary-page-replaces-board-focus.md (the summary page is the only Epic surface, reached at `/epic/:ref`; the board's epic-focus mode is removed)

## Context

ADR-0011 presents an Epic as **its board of open tasks** — members as ordinary
board cards, a rail of closed tasks, status pips, and, once the Epic reaches
integration, the whole-Epic steps bar. That surface serves *active* work on the
Board well, but two gaps have opened:

- Epics are now first-class in the **Tasks list history** (the `isEpic` flag
  badges and links them, closed ones included) and are reachable from the
  **Graph**. Opening one should land somewhere that reads as an Epic, not the
  plain Ticket page.
- Operators want an **at-a-glance summary** of an Epic — its integration
  progress, aggregated usage/cost/reliability, and its child tasks — for *any*
  Epic, including **closed/historical** ones. The board-of-tasks presentation is
  built for live columns, and the derived Epic read model is **open-only**, so a
  closed Epic has no rich surface at all.

## Decision

Add a dedicated **Epic summary page**, complementary to (not a replacement for)
ADR-0011's board-of-tasks presentation, which stays for active-epic work on the
Board.

- **Reached by** opening an Epic ticket from the Tasks list (`isEpic` rows) or
  the Graph. The Board's epic-focus mode is unchanged.
- **Layout** mirrors the Ticket-page shell: header (title, an `EPIC` tag, state),
  description, then a body of —
  - the **integration progress bar** shown **as-is** from ADR-0011 / ADR-0001:
    whole-Epic `verify → merge into develop → post-merge check → retire`, current
    step and any escalation legible. It is **read from the server Epic read
    model**, never client-inferred.
  - epic **properties** (depends-on, base branch, created, last activity);
  - an aggregated **Usage & statistics** block — cost, tokens, attempts, failure
    rate, duration, per-model — computed with **ADR-0008's locked formulas**,
    scoped to the Epic's child Attempts;
  - a **child-tasks table** using the **Tasks-list columns** (ADR-0011 lean list
    rows) plus an inline per-task token bar.
- **Epic-scoped stats** aggregate over the Attempts of the Epic's child tasks
  (`task.trackerParent = <epic ref>`), reusing the existing stats aggregation and
  ADR-0008's formulas — no new metric definitions.
- The **Epic read endpoint(s) and the stats scope are extended to resolve any
  Epic**, closed/historical included, so a history row opens a full page rather
  than a 404.

## Consequences

- The Epic read model and stats scope must resolve **closed** Epics, which today
  derive only from open tickets — a bounded server-side fold (ADR-0007's
  event-loop guarantee), not a new write path.
- **Two Epic surfaces coexist**: the Board's board-of-tasks (active work) and the
  summary page (any Epic, at-a-glance + history). They read the **same
  server-authoritative integration facts** and share the merged/merging
  vocabulary, so they must not drift.
- The child-tasks table reuses the lean Tasks-list row contract and the `isEpic`
  flag already shipped; no bespoke row shape.
- Integration state stays server-only (ADR-0011): the progress bar renders what
  the read model reports and never re-derives it from child states.

## Supersedes

None. Refines ADR-0011's Epic presentation by adding a complementary summary
surface; the board-of-tasks presentation is unchanged.
