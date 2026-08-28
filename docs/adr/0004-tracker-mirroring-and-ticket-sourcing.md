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

## Absorbed at the reset

Pre-reset 0030 in full (derivation, claim, scheduling, priority, status,
skip reasons, reclaim), 0014, 0017, 0025 (cascade list updated), 0024's
derivation clauses, 0041's tracker-as-output clause; 0011's residue arrives
via 0041 (closure is an output). See README.md for the mapping.
