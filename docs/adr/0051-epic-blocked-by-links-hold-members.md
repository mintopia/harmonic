# Decision: An Epic's blocked-by links hold its Members

Status: accepted
Date: 2026-10-09

Amends ADR-0016 (an Epic's own blocked-by links are now respected) and refines
ADR-0018 (the stored Epic `state` decides when an Epic blocker is satisfied).

## Context

Harmonic ignored tracker blocked-by links declared on an Epic. In a real
deployment (mintopia/musicparty), Epic #73 was blocked by Epic #71. Member #101
of #73 was started before #71's code was integrated into the base branch, so it
ran against a tree that lacked the work it depended on.

The cause is the mirror. It drops any blocked-by edge that points at a parent
container (ADR-0016: an Epic contains its children, it does not gate them), and
an Epic is a stored container, not a Task, so its own blocked-by links never
became Task-level Blocker edges. Nothing consulted them at pick time.

## Decision

**If an Epic has blocked-by links, no Member of that Epic is agent-workable
while any blocker is unsatisfied.** This is the **Epic Hold**.

- **Derived, never stored.** The hold is computed at read time from the
  persisted `tracker_containers.tracker_blocked_by`, the stored `epics.state`,
  and the mirrored Tasks' state. It is never written into `task_dependencies`,
  so the ADR-0016 rule that an Epic edge is not projected as a Task-level
  Blocker is unchanged, and the hold cannot go stale.
- **Scope.** The blockers of every Epic above a Member count, so a parent
  Epic's blocker gates the Members of its child Epics. A blocker that is itself
  an ancestor of the Member is ignored.
- **Satisfaction.** An Epic blocker is satisfied only when its stored state is
  `integrated` (merged into base, or completed in place). Closing the Epic's
  ticket is not enough: the code must be in base. A Task blocker is satisfied
  when the mirrored Task is `done`; cancelled and escalated Tasks keep holding.
  A non-Epic container blocker is satisfied when every stored Epic beneath it is
  integrated.
- **Unknown refs.** A blocker that matches no Epic, mirrored Task, or container
  is ignored, matching how the mirror treats unscanned refs.
- **Cycles.** Epics that block each other both stay held. The blocker is flagged
  `cycle` so the board and skip reason can say why nothing will move.
- **Visibility.** The hold counts toward `openBlockerCount`, is listed in
  `epicBlockers` on the Task API, and appears as chips on the Board. The
  Auto-Runner skip reason names it (`Epic #73 waits on #71 (not integrated)`).
- **Running Members are not interrupted.** The hold gates pickup only.
- **Stale integration branch.** When a Member's Epic has Epic blockers and its
  `epic/<ref>` branch exists but does not contain the base branch tip, the
  Member is held as `stale` rather than started. The existing currency pass
  refreshes the branch when the blocker integrates. Unlike a `missing` branch,
  a stale one is never escalated after the grace window: the refresh is
  expected to finish it. The currency pass tests whether the base is already in
  the Epic branch, so a branch with no commits of its own is refreshed too.
- **Manual start bypasses the hold.** `POST /tasks/:id/run` and a retry with
  `startNow` skip the hold, as they already skip Task-level Blockers. The git
  freshness check still applies, so a stale branch still refuses a manual
  start. A retry without `startNow` requeues the Task to `ready`, where the
  Auto-Runner applies the hold.

## Consequences

- Dependent Epics run in order without the operator babysitting Member starts.
- A blocker Epic that is closed but never integrated holds its dependents until
  an operator integrates or removes the link. This is deliberate: closing a
  ticket does not put code in base.
- Every read that reports `openBlockerCount` or `agentWorkable` loads the
  container, Epic, and blocker-Task state once per call, not per Task.
- An operator can still force a Member through with a manual start; that is an
  explicit human decision, consistent with Task-level Blockers.

## Supersedes

None wholesale. Amends ADR-0016 and refines ADR-0018.
