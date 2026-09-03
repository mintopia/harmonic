# Decision: Operations is a worktree control surface — inventory, operator force-cleanup, reconcile-on-demand

Status: accepted
Date: 2026-09-03

Amends ADR-0010 (see "Amends" below).

## Context

ADR-0010 gave the Operations surface three read-only sections: the live
Operations span tree, the Scheduled Jobs table, and — for worktrees — a
flagged-worktrees list whose disposition was "manual, out-of-band". Boot/periodic
reconciliation reconciles `git worktree list` against the DB, recreates a live
Task's missing worktree, **auto-removes only clean worktrees of terminal Tasks,
and never deletes a dirty or unreadable one** — surfacing those for an operator
instead.

That leaves the operator with visibility but no verb. The page reports drift and
then expects them to SSH in. Concretely:

- The flagged list shows only the *broken* subset (dirty / unreadable /
  unrecognized). Healthy worktrees, their branches, and the overall disk⋈DB
  picture are invisible, so "what is on disk and does it match the DB" is
  unanswerable from the UI.
- The reconciler already carries the removal capability
  (`git.removeWorktreeAndDeleteBranch`); nothing in the UI can invoke it.
- Legacy `run-<id>` worktrees are flagged `unrecognized` and then linger forever —
  reconciliation only reaps `task-<id>` names, so an orphan is never cleaned.
- Reconciliation runs on a deliberately slow ~30-min cadence; when disk and DB
  drift, the operator cannot force a pass.

## Decision

Operations becomes a **worktree control surface**. Three additions, all
consistent with ADR-0010's automation invariant.

### 1. Worktree inventory read model (computed, never persisted)

A live read model joins `git worktree list` against the mirrored Task rows, per
Workspace. Each entry carries path, branch, subject (owning Task/Epic), on-disk
size, dirty flag, and a derived **state**:

- **Active** — worktree of a non-terminal Task.
- **Stale** — worktree of a *terminal* (done/cancelled) Task, still on disk.
  Derived purely from Task state; it is exactly what boot/periodic reconciliation
  auto-removes when clean, made visible in the window before the next sweep.
- **Dirty** — uncommitted changes (the ADR-0010 flag).
- **Unreadable** — registered but git cannot read it (the ADR-0010 flag).
- **Orphan** — on disk under the managed root, no matching Task (the ADR-0010
  `unrecognized` flag; includes legacy `run-<id>` layouts).
- **Missing** — non-terminal Task with no worktree; reconciliation recreates it.

State is a function of `git worktree list` ⋈ Task rows ⋈ dirtiness, computed on
read. It is **not persisted** — no new registry, no flag column — so ADR-0010's
"operation aggregates are never persisted" holds. Served as a `GET /api/worktrees`
snapshot plus firehose event, the same read-model shape the flagged list already
uses (which this supersedes).

### 2. Operator force-cleanup is explicit disposition

A confirmed, operator-initiated **force-cleanup** removes a worktree and deletes
its branch via the existing `git.removeWorktreeAndDeleteBranch`. This is the
"operator disposition" ADR-0010 deferred to a human — not a change to the
automation.

- **Automation still never deletes a dirty or unreadable worktree.** The
  ADR-0010 invariant is untouched; only an explicit human action can.
- The action is **guarded**: cleaning a Dirty worktree requires a confirmation
  that names the branch and the uncommitted files that will be lost; a Stale or
  Orphan clean (no uncommitted work) is low-stakes and unguarded beyond the
  action itself.
- **Managed-root only.** Only paths under the managed worktree root are
  cleanable, enforced server-side (the `isInside(managedRoot, path)` guard the
  reconciler already applies), so no UI input can target an arbitrary path.
- Served as `POST /api/worktrees/:id/cleanup`.

### 3. Reconcile-on-demand

`POST /api/operations/reconcile` triggers the existing `WorktreeReconciler.reconcile()`
and returns its `{ removed, recreated, flagged }` result. It is the same job the
scheduler runs, invoked manually — single-flight with the scheduled pass, so a
manual trigger and the timer cannot run it twice at once.

The Scheduled Jobs and live Operations sections stay, refined for the surface:
live Operation rows gain their owning Task/Epic subject; Scheduled Jobs render as
a compact strip.

## Consequences

- Two new read/write endpoints (`/api/worktrees`, its `:id/cleanup`) and one
  action endpoint (`/api/operations/reconcile`); `GET /api/worktrees` subsumes
  and replaces `/api/flagged-worktrees` and its firehose event.
- Force-cleanup is a genuinely destructive, shared-effect action reachable from
  the UI — the guard (loss-listing confirm for dirty, managed-root enforcement)
  is load-bearing and must be server-side, never only in the client.
- The inventory read model recomputes state per read from `git worktree list`
  plus Task rows; a large fleet pays repeated `git` subprocess cost, so the
  endpoint is snapshot+firehose like the surfaces it replaces, not polled hot.
- The Stale state closes the "done Task's worktree lingers, unexplained" gap and
  gives the long-standing legacy `run-<id>` orphans a disposal path, without any
  new persisted state.

## Amends

ADR-0010 (Observability — Operations and Scheduled Jobs): replaces the
flagged-worktrees list ("disposition is manual, out-of-band") with a full
worktree inventory and an explicit operator force-cleanup + reconcile-on-demand.
ADR-0010's automation invariant is unchanged — reconciliation still auto-removes
only clean terminal worktrees and never deletes a dirty or unreadable one; this
ADR adds the human disposition path 0010 deferred, and adds nothing to persisted
state.
