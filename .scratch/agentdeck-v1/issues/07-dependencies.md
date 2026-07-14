# Dependencies

Status: ready-for-agent

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

- [ ] Dependencies can be added to and removed from a Task via UI and REST
- [ ] A Task with unmet Dependencies is blocked; it becomes ready automatically when its last Dependency completes
- [ ] A Dependency finishing its Run does not unblock dependents — only Accept (completed) does
- [ ] Dependents of a failed Dependency stay blocked and show a blocked-on-failed flag; re-queuing and completing the Dependency clears it
- [ ] Cancel-with-dependents cancels the Task and its whole dependent chain in one action
- [ ] Adding a Dependency that would create a cycle is rejected with a clear error
- [ ] REST-seam tests cover unblock-on-accept (not on finish), blocked-on-failed flagging, cascade cancel, and cycle rejection

## Blocked by

- `05-review-accept-reject.md`
