# Decision: Web UI and API conventions

Status: accepted
Date: 2026-08-28
Reconciled: 2026-10-02. Epic and Global navigation follow ADR-0017/0018/0033; Paper remains the visual system.

Part of the 2026-08-28 ADR reset (see README.md). The reset UI work
shipped; the current Epic presentation follows ADR-0017/0018.
Refined by: 0017-epic-summary-page-replaces-board-focus.md (the epic-focus
"board of open tasks" surface below is retired; the Board shows every Epic as a
band and Epic clicks open the summary page at `/workspace/:id/epic/:ref`).
Refined by: 0033-global-scope-and-path-routing.md (the `?view=` scheme is retired
for path-based routing; under Global scope, search is instance-wide and an absent
`workspaceId` on a list endpoint means all Workspaces).

## API conventions

- **OpenAPI is generated from zod route schemas** at runtime
  (`fastify-type-provider-zod` + `@fastify/swagger`), served at
  `/api/openapi.json`/`.yaml` and rendered by the app's own reference
  component (not an embedded Swagger UI). The spec endpoints are deliberately
  unauthenticated (open-source surface). **A schema-less route is a defect**:
  new routes declare zod schemas or they ship undocumented and unvalidated.
- **List endpoints are lean, paginated, server-filtered, and server-searched;
  full detail lives on the item GET.** One shared `limit`/`offset`/`total`
  contract across every list endpoint; filters are flat query params (state
  incl. the `open` pseudo-state, harness, priority, sort) with no
  mode/`view` flags; `q` searches server-side over prompt and title. List
  rows omit heavy fields (a bounded server-derived `summary` replaces the
  full prompt); consumers are decoupled — the detail modal fetches by id, the
  graph fetches its own whole-graph data lazily, dependency chips read
  server-authoritative blocker counts.

## The design world

- **Paper is the design language**; the app is serious and restrained. The
  three-place theming in `web/src/index.css` (light / `data-theme` / system)
  is retained, and the **contrast test is the hard CI gate** for every
  documented token pairing.
- **The running amber now clears AA in both themes** (issue #458). It was
  formerly a bounded sub-AA exception (permitted because running state is never
  carried by colour alone — pulsing dot, text label, structural position), but
  #458 retired that carve-out: the light amber was darkened until the Working
  chip and the count/figure text meet the 4.5:1 floor, so the contrast gate now
  holds every state colour to AA with no exceptions. The Blocked slate was
  nudged the same way in the same pass.
- Vocabulary in UI copy: **merged / merging** (never the banned pre-reset
  merge synonym), Task/Ticket per ADR-0001, Steps for Attempt timeline rows.

## The Board and the Graph

- The Board renders sections, not state columns — needs-you first, then
  running, then pending grouped by open-blocker count — with non-workable
  (human-only) tickets muted with a distinct icon.
- The **Graph** view is read-only: elkjs layered layout, hand-rolled SVG.
  Active-state tasks by default with a toggle for terminal ones; Epic
  membership is expressed as layout grouping, never a drawn container; node
  click deep-links to the task detail.

## The Epic presentation

The Board shows active Epic bands with ordinary member Task cards. Opening
an Epic goes to its dedicated summary page; it never replaces the Board
with a single-Epic focus mode (ADR-0017). Stored Epic facts make the summary
available after integration and branch retirement (ADR-0018):

- Active tasks are shown as normal; a **rail below the columns** holds the
  Epic's closed (merged/cancelled) tasks so finished work stays visible
  without crowding the columns.
- **Colour-status pips in the top right** of the Epic surface summarise every
  member's state at a glance (one pip per task).
- Once the Epic is complete and ready to merge, the surface shows a
  **steps/progress bar of the integration**: whole-Epic verify → merge into
  develop → post-merge check → retire, with the current step and any
  escalation legible (ADR-0001's integration gate).
- Epic data comes from the server-derived read endpoints (`GET …/epics`,
  `GET …/epics/:ref`), refetched on the `task_changed` poke — the branch tip
  and integration state are server-only facts, never client-inferred.

## The Ticket page

- The **lifecycle timeline** is the chronological audit view: a ticket-scoped,
  time-ordered projection folding Attempt/Step transitions, verification
  outcomes (including skipped/disabled), guardrail trips, escalations,
  operator dispositions, merges, post-merge results, and reverts — derived on
  read from persisted events, no new write path, placed in the main panel
  below description/stats and above the per-Attempt section.
- Task detail composes Attempt navigation, changed files, and operator
  actions. Progress distinguishes pending, failed, completed, and skipped
  stages using actual Attempt/Step results and the isolation mode.
- Verification rendering rules are ADR-0003's (always visible, per-verifier
  status, subagent-attributed transcript).

## Consequences

- The lifecycle projection must stay a bounded server-side fold (ADR-0007's
  event-loop guarantee).
- Search is server-side and follows the route scope: Workspace-wide or
  instance-wide in Global scope (ADR-0033).
- The generated `website/src/openapi.json` snapshot is regenerated by the
  docs workflow, never hand-edited (and not regenerated inside unrelated
  changes).

## Absorbed at the reset

Pre-reset 0005, 0045, 0034's durable rules (Paper, contrast gate, merged/
merging vocabulary; the spent migration sequence dropped), 0033, 0015, 0026's
board-hosted read model (the peek, merge-train hero, and force-merge rail
replaced by the Epic presentation above, owner-designed), 0042 Decision B
(source list re-based to post-reset events). See README.md for the mapping.
