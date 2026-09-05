# Decision: Tracker mirroring and ticket sourcing

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

## The local DB is the source of truth for agent work

The tracker is the source of truth for **inbound facts only**: lifecycle
state, parent, blockers, labels, title, body. The poll upserts those facts
onto the per-issue record; everything the scheduler reasons over reads the DB,
not the live scan — durable across restart, single-sourced. Tracker
interaction (claim, comment on escalation, close on done) is an **output
side-effect, never a control path**; ticket closure is not the success signal
— the verification verdict and the merge are.

- **Eligibility is the `ready-for-agent` label, never assignment.** A ticket
  is pick-eligible when it is open, carries `ready-for-agent`, has no open
  blocker, and is not already worked locally. The tracker assignee is not
  read at all; the signal is adapter-normalised into `Ticket.labels[]`.
  Legacy unlabeled tickets stay human-only by design — visible (they can
  block others) but never agent-workable.
- **Ownership is a local column.** Claiming is the local `ready → working`
  transaction; releasing is a local transition. `@me` may be pushed outbound
  as a courtesy, never read back.
- **Scheduling is self-driven off the DB.** On an interval or freed capacity
  the scheduler queries for the highest-priority eligible task, claims it
  locally, and runs it; the poll is a pure fact-sync sidecar.
- **Priority is DB-owned**, ordered: explicit priority, then topological
  (unblocked-first, then unblock-count), then age.
- **Status is bidirectional, gated by adapter capability.** Harmonic pushes
  lifecycle on verified transitions and accepts inbound changes it did not
  originate (a human reopen, or removing `ready-for-agent`, is truth). An
  inbound close while a Task still runs is premature: reopen plus escalate.
  A tracker that cannot write degrades to inbound-only.
- **Non-pickup is always legible.** Every eligible-but-unpicked task carries
  a current skip reason (`blocked-by #n`, `at capacity`, `integration branch
  missing`, `workspace disabled`, `hitl`); a reason that cannot self-resolve
  escalates rather than looping.
- **The human-reclaim contract**: remove the `ready-for-agent` label; do not
  self-assign. Harmonic is assumed to be the sole agent-executor of labelled
  tickets in a repo.

Dependencies mirror as edges; a mirrored `Blocked by: #n` line must be **one
line per declaration** (`parseBodyBlockers`), and blocked-ness is derived
from open-blocker count, never stored.

## Epics are derived, never authored

Epic membership and wave order come from the tracker's parent/child structure
(native sub-issues and dependencies, with `## Parent` / `Part of #n` /
`Blocked by: #n` body lines as fallback). Harmonic authors no Epic structure
and stores no grouping entity; missing or messy structure degrades gracefully
to per-task behaviour, never breaks.

## Tracker configuration and resolution

- Tracker enable/interval are **Workspace-only** — no global default, no
  inherit affordance: a global "enabled" would start every Workspace polling
  a repo that may declare no tracker. (The one-time `backfillDefaultWorkspace`
  shim has served its purpose and is removable.)
- The **Resolved Tracker** (which tracker a repo declares, or why resolution
  failed) is derived in-memory in the poller manager and merged into API
  responses at serialize time — never a persisted column. Resolution is a
  pure function of repo files; persisting it is a staleness trap. Ephemerality
  is intended: after restart the boot sync recomputes from the live repo. The
  tension with DB-held ticket facts is settled, not open: facts are external
  mutable state the scheduler must act on even when a poll is slow;
  resolution recomputes cheaply on boot.

## Deletion and dismissal

**Cancel** abandons deliberately and keeps the record. **Delete** removes the
Task outright — guarded to a Task that is not currently running — with four
guarantees:

1. **Non-running guard**: `state !== 'working'`, matching Workspace deletion;
   any parked harness process is torn down first.
2. **Atomic cascade**: one transaction removes the Task's Attempts and their
   dependent rows, sessions, channels, and dependency edges (both
   directions), then the task row — and, for a mirrored Task, writes the
   tombstone in the same transaction.
3. **Dependent re-derivation**: former dependents re-derive (blocked →
   ready), the same as any edge change.
4. **`task_removed` firehose event** so a live board drops the Task
   immediately.

A mirrored delete is a **Dismiss**: it also writes a durable per-Workspace
tombstone into `tracker_dismissals` keyed `(workspaceId, trackerRef)`, which
the poller consults before re-mirroring, so a re-poll can never resurrect it.
Un-dismiss is manual tombstone removal.

## Consequences

- The pre-reset cascade list is rewritten against the post-reset schema: no
  merge journal, no lease or turn-queue tables; Attempts replace Runs.
- Persistence mechanics (single-writer queue, transactions) are ADR-0007's;
  this ADR defines the tracker-facing behaviour and cross-references it.
- Portability: everything the scheduler reads is normalised at the
  `TrackerAdapter`/`Ticket` seam; no tracker-specific logic reaches the
  domain.

## Amendment (2026-09-05): file-backed tracker closes commit to base, never orphan a working tree

Status: accepted — amends the "Status is bidirectional" clause above.

### Defect

The "close on done" output is safe for API trackers (`gh`/`glab` mutate remote
state) but broken for the file-backed **local-markdown** tracker, whose
`close`/`reopen` rewrite the ticket's `**Status:**` field in a working tree
(`src/tracker/local-markdown.ts`, `writeStatus`). Harmonic issues that write
against `task.workingDir` **after** the branch has already merged
(`src/execution/auto-drive.ts`, `closeTicket`, reached from `onCompleted`'s
`auto-merge` fate) and **never commits it** — `onTicketClosed` only records a
Timeline event.

The result is an uncommitted modification to a tracked, committed file:

- The closed status never reaches base — the merge is already complete when the
  write happens.
- The working tree is left dirty, so the next git operation over it collides: a
  checked-out base merge bails at `src/execution/branch-merge.ts`
  (`isDirty(checkoutDir)` → `fallback-pr-manual`), and a reused task worktree
  cannot reset to base.

This is what surfaces as the local-markdown tracker's ticket files causing
conflicts when merging development branches. The tracker's file format is fixed
by the upstream skill, the files must stay committed, and they must live in the
worktree — so the fix cannot move, ignore, or reformat them. It must **commit**
the write in the right place.

### Decision

For a **write-capable, file-backed tracker**, a lifecycle status push is
materialised as a **commit on the base branch**, produced inside the merge's
locking discipline (ADR-0001) — never as a loose working-tree write, and never
against `task.workingDir`:

- **Checked-out base (in-place merge):** while the merge mutex is held, rewrite
  the ticket file in the base checkout, stage the ticket path, commit, and
  advance the tip through the same ff-only/CAS discipline the merge uses. The
  working tree ends clean.
- **Bare / CAS base:** perform the rewrite-and-commit in the detached admin
  worktree the merge already spins up (`branch-merge.ts`,
  `mergeIntoBaseUnchecked`, `mode: 'merge'`), then CAS-update the base ref.

The push stays **best-effort and non-blocking**: a failed status commit
escalates and records exactly as today and never reverts the code merge. It
remains an **output side-effect** — it does not gate the merge and is not the
success signal (the verdict and the merge are), preserving this ADR's
control-path rule. API trackers are unchanged: their close is a remote call
with no working tree.

### Consequences

- The closed `**Status:**` reaches base as a normal committed change (one file
  per ticket ⇒ one-sided, no cross-ticket conflict), honouring the
  bidirectional-status contract for file-backed trackers.
- No tracker write is ever left in a working tree, so `branch-merge.ts`'s
  dirty-checkout bailout and the task-worktree reset stop tripping over the
  ticket files.
- `closeTicket` moves off `task.workingDir` onto the base target; the tracker
  close becomes part of the merge sequence's locked region rather than a
  detached, uncommitted follow-up.
- Follow-up work: thread the commit through the merge/close path
  (`auto-drive.ts` + `branch-merge.ts`), have the file-backed adapter's close
  yield the intended file edit so the merge layer can commit it, and add a
  git-integration test asserting a local-markdown auto-merge leaves the base
  checkout clean with the ticket closed on base.

## Absorbed at the reset

Pre-reset 0030 in full (derivation, claim, scheduling, priority, status,
skip reasons, reclaim), 0014, 0017, 0025 (cascade list updated), 0024's
derivation clauses, 0041's tracker-as-output clause; 0011's residue arrives
via 0041 (closure is an output). See README.md for the mapping.
