# Decision: The Epic summary page replaces the board's epic-focus surface

Status: accepted
Date: 2026-09-01
Reconciled: 2026-10-02. The Board focus view is retired; ADR-0018 adds stored history and ADR-0033 scopes the URL.

## Context

ADR-0011 §"The Epic presentation" retired the old Epic Peek and replaced it with
an **epic-focus surface**: clicking an Epic swaps the whole Board for a
single-Epic "board of open tasks" (members as cards, status pips, a merge-train
hero, and a force-merge rail). ADR-0015 then added a dedicated **Epic summary
page** *alongside* it and explicitly kept the focus surface ("The Board's
epic-focus mode is unchanged"), so two Epic surfaces coexisted.

In practice the focus surface is the wrong interaction and was never wanted:

- Every Epic entry point that should open the summary page — the Tasks-list Epic
  row, the Table's Epic group header, the Board's Epic band header — instead
  routed to the focus surface (`setFocusEpic` → `EpicBoard`), swapping the whole
  Board for one Epic. Opening an Epic reads as "the Board was replaced by a
  detail view", which is not what the mocks/spec agreed.
- The summary page (`EpicPage`) — the task-detail-style surface with the
  integration step bar, aggregated usage, and the child-tasks table — was
  therefore effectively unreachable. Its only wiring was a `focusedSurface()`
  seam over `/task/:id` for a mirrored `isEpic` task, a path nothing navigates to
  (ADR-0016 made Epics derived containers, and the synthetic Epic list-row's `id`
  is a ticket number that collides with the task-id space).
- The Board should show **every** non-complete Epic at once, each as a
  self-contained band, not force a one-at-a-time focus.

## Decision

The Board never enters a single-Epic focus mode. The Epic summary page is the
one rich Epic surface.

- **The Board always shows every active Epic as a band** (name + status pips +
  merge train, then its open members laid out in blocker-count columns, then a
  collapsed closed-task rail). The global `Attention` and `Running` sections stay
  at the top; a running or escalated member appears **both** in its Epic band and
  in the global section.
- **Every Epic entry point opens the Epic summary page** at a dedicated
  **`/workspace/:id/epic/:ref`** route: the Tasks-list Epic row, the Table Epic group header,
  the Board Epic band header, and a child Ticket's breadcrumb (which links up to
  its parent Epic). The summary page is keyed by Epic ref and reads the server
  Epic read model directly — no synthetic task row, no `/task/:id` overload.
- **The `EpicBoard` focus surface, `focusEpic` state, and the `focusedSurface`
  routing seam are removed.**

## Consequences

- Retires ADR-0011's "Epic presented as its board of open tasks" focus surface
  and ADR-0015's retention of it. The summary page (ADR-0015) is unchanged in
  content; only its route and keying change (ref, not a mirrored `isEpic` task).
- One Epic surface, not two — the coexistence risk ADR-0015 flagged ("they must
  not drift") is gone.
- ADR-0033 scopes Epic and Task routes by Workspace; they retain separate
  identity spaces. The dead
  `isEpic`-task → summary path and its `focusedSurface` seam are deleted.
- The band model reads every open member (ready/blocked/running/escalated) from
  the derived Epic read model; deliberate duplication into the global
  Attention/Running sections is intended, not a bug.
- ADR-0018 subsequently shipped stored Epic identity and historical diffs
  anchored on the integration merge commit. The summary page reads that
  durable record; an integrated Epic leaves the Board.

## Supersedes

Refines 0011-web-ui-and-api-conventions.md (retires its epic-focus board
presentation) and 0015-epic-summary-page.md (the summary page is now the only
Epic surface and is reached at `/epic/:ref`, not via a mirrored `isEpic` task).
