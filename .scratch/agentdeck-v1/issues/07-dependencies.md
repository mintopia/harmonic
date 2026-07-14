# Dependencies

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Directed edges between Tasks so pipelines execute in order. An operator can
declare that a Task depends on other Tasks; a Task with any unmet
Dependency sits in blocked and becomes ready automatically when the last
one completes. Only *completed* — accepted, not merely finished — satisfies
dependents, so unreviewed or failed work never feeds downstream Tasks.

Failure does not cascade: dependents of a failed Dependency stay blocked
and carry a visible "blocked on failed dependency" flag, so a retryable
hiccup doesn't destroy the pipeline. A "cancel Task and its dependents"
action tears down an obsolete chain in one step. Adding a Dependency that
would create a cycle is rejected at creation time.

The board and Task views surface Dependencies both ways (what this Task
waits on, what waits on it) and the blocked-on-failed flag.

## Acceptance criteria

- [x] Dependencies can be added to and removed from a Task via UI and REST
- [x] A Task with unmet Dependencies is blocked; it becomes ready automatically when its last Dependency completes
- [x] A Dependency finishing its Run does not unblock dependents — only Accept (completed) does
- [x] Dependents of a failed Dependency stay blocked and show a blocked-on-failed flag; re-queuing and completing the Dependency clears it
- [x] Cancel-with-dependents cancels the Task and its whole dependent chain in one action
- [x] Adding a Dependency that would create a cycle is rejected with a clear error
- [x] REST-seam tests cover unblock-on-accept (not on finish), blocked-on-failed flagging, cascade cancel, and cycle rejection

## Blocked by

- `05-review-accept-reject.md`

## Comments

**2026-07-14 (agent):** Done. `task_dependencies` edges with cycle rejection
(BFS reachability, 409), blocked derivation on create/promote/requeue and
on edge add/remove, auto-unblock inside `setState('completed')` — only
Accept satisfies dependents; a finished-but-unreviewed run does not.
`blockedOnFailed` computed flag (failed or cancelled dep). Cancel accepts
`{withDependents:true}` and tears down the transitive chain, killing any
running harnesses. REST: POST/DELETE /api/tasks/:id/dependencies; all task
payloads now carry dependsOn/dependents/blockedOnFailed. UI: dep badges +
blocked-on-failed flag on cards, dependency editor and cancel-with-
dependents in the task detail.
