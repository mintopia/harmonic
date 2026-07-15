# Linked re-attempts — design

**Date:** 2026-07-15
**Status:** approved (design), pending implementation

## Problem

Retrying a rejected/failed task currently re-queues the *same* task and
string-concatenates the reviewer's feedback into `task.prompt`
(`domain/tasks.ts` `requeue`). This mangles the original prompt, loses the
clean separation between prompt and feedback, and leaves no visible link
between an attempt and what it descends from.

## Decision

A re-attempt is a **new task linked to the original** (not the same task
re-run). Chosen over "same task, attempts = runs" for a visible lineage in
the list view.

Locked sub-decisions:
- The re-attempt **copies** the original's prompt into its own row
  (self-contained: editable, runnable, unaffected by later edits to the original).
- The `↻ re-attempt of #N` badge appears in the **list (Table) view only**,
  not on the board card.
- The old `POST /api/tasks/:id/requeue` endpoint **stays** (API back-compat,
  existing tests untouched) but the UI stops using it; a new
  `POST /api/tasks/:id/reattempt` replaces it in the UI.

## Data model

Two nullable columns on `tasks` (new drizzle migration `0006_reattempt.sql`,
generated via `drizzle-kit generate` after editing `src/db/schema.ts`):

- `reattemptOf` — `integer`, nullable, references `tasks.id`. The original
  this task descends from.
- `feedback` — `text`, nullable. The reviewer's feedback that seeded this
  re-attempt, stored **in full**, separate from `prompt`.

`TaskWithDeps` extends `TaskRow`, and `taskToApi` spreads the row, so both
fields reach the API automatically. Add them to:
- the web `Task` type (`web/src/types.ts`),
- the route response `taskSchema` (zod) in `src/server/routes/tasks.ts`,
- optionally a derived reverse link `reattempts: number[]` on `TaskWithDeps`
  (tasks whose `reattemptOf` = this id) so the original can show
  "re-attempted as #M".

## Domain

New `TaskService.reattempt(originalId, feedback?)`:
- reads the original; creates a NEW task copying `prompt`, `harness`, `model`,
  `workingDir`, `isolationMode`, `priority`, and its `dependsOn`,
- sets `reattemptOf = originalId` and `feedback`,
- state = `ready` (or `blocked` if deps unmet), same rule as `create`,
- leaves the original untouched; emits `onChanged` / `task.created`.

## Runner

For a task with non-empty `feedback`, the run prompt is assembled at run
time (`execution/runner.ts` ~L254) as:

```
<task.prompt>

## Feedback from the previous attempt

<task.feedback>
```

Storage stays pristine; the agent still sees the feedback.

## Retry entry points (both create a linked re-attempt)

- **Reject modal → "Send back to Ready"** (`RejectDialog.tsx`): reject the
  awaiting-review task (run marked rejected, original → `failed`), then
  `reattempt(originalId, feedback)`.
- **Failed card → "Re-queue"** (`TaskCard.tsx`): opens a lightweight feedback
  dialog (feedback textarea + "Create re-attempt"; feedback optional) that
  calls `reattempt(id, feedback)`. Both this and the reject modal's "Send back
  to Ready" call the same `api.reattempt` — the reject modal additionally
  rejects the awaiting-review run first.

## UI

- **Table view:** re-attempt rows show a `↻ re-attempt of #N` badge (neutral
  raised chip, mono id), clickable to open the original.
- **Task detail:** for a re-attempt, render the prompt, then a **Feedback**
  section shown **in full** (no line-clamp), plus a link to the original;
  the original shows "re-attempted as #M" when present.

## Tests

- `reattempt()`: copies config + deps, sets `reattemptOf`/`feedback`, original
  untouched, `blocked` when a dependency is unmet.
- Runner prompt composition includes the feedback section when `feedback` set,
  and is unchanged when it isn't.
- Route: `POST /api/tasks/:id/reattempt` returns the new task; response carries
  `reattemptOf` + `feedback`.

## Out of scope

- Removing the `requeue` endpoint/domain method (kept for back-compat).
- Board-card badge.
