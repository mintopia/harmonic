# Decision: Task lifecycle is an enforced state machine with per-Task operation serialization

Status: accepted
Date: 2026-09-02

## Context

A Task's `state` (`draft → ready → working → done`, plus `escalated` and
`cancelled`, ADR-0001) is mutated from many places: the operator actions
(`promote`, `requeue`, `uncancel`, `cancel`, `complete`), the Attempt settle
coordinator, the Auto-Runner, boot crash-recovery, and the escalation/accept
flow. The operator-action methods each guard their entry state and throw
`invalid_state` on a bad one. But the shared writer, `TaskService.setState`, is
an **unguarded** write: it moves a Task from any state to any state, and the
settle / requeue / auto-run paths all go through it with no from→to validation
and no serialization between concurrent operations on the same Task.

This produced a real defect (task 452): an operator Accept began its merge — a
slow, conflict-resolving merge under the Workspace mutex — while the verify path
timed out and requeued the Task to `ready`. The two operations interleaved on
one Task; the merge completed and recorded `merged`, but the Task was left
`ready`: a merged branch behind an open ticket. Boot reconciliation now repairs
the end-state (see crash-recovery), but the interleaving that caused it is still
reachable at runtime, and nothing stops an illegal jump such as `done → ready`.

Harmonic is one Node process against local repositories for one operator
(ADR-0001). The fix must therefore be in-process invariants, not the durable
leases / CAS / journals ADR-0001 rules out of scope.

## Decision

**1. Legal transitions are a table, enforced centrally.** `setState` (and the
settle/requeue paths that reach it) validate the `from → to` edge against a
single table and throw `invalid_state` on an illegal edge. Terminal states
(`done`, `cancelled`) have no outgoing edge except the one explicit reopen
(`cancelled → ready` via `uncancel`). The table is the whole legal machine:

| from      | allowed to                          |
|-----------|-------------------------------------|
| draft     | ready, cancelled                    |
| ready     | working, escalated, done, cancelled |
| working   | ready, escalated, done, cancelled   |
| escalated | ready, done, cancelled              |
| done      | — (terminal)                        |
| cancelled | ready                               |

(`ready → done` is the reconcile-only edge for a merge that settled its Attempt
before the Task reached `done`; every other edge already has a caller.)

**2. Task-mutating operations serialize per Task.** A per-Task in-process mutex
— a keyed variable, the same pattern ADR-0001 blesses for the merge (a variable,
not a table) — wraps each mutating operation (accept, requeue, cancel, complete,
settle, auto-run claim). A long operation (an Accept whose merge is resolving
conflicts) holds its Task's lock for its whole verify→merge→settle span, so no
other path can transition that Task underneath it. An operation that finds the
state has moved when it acquires the lock re-reads and either proceeds or fails
cleanly — never blind-writes.

The lock is process-local and rebuilt empty at boot; nothing durable is added.

## Consequences

- The interleaving that stranded task 452 becomes unreachable: Accept holds the
  Task across its merge, and the verify/requeue path waits or no-ops. Boot
  reconciliation stays as a belt-and-braces net, not the primary guarantee.
- Illegal transitions (terminal → anything, `cancelled → working`) throw instead
  of silently corrupting; the ~600 nominal state combinations ADR-0001 set out
  to shrink get one fewer source of drift.
- Every existing legal edge must be in the table or a real path breaks — the
  table is exhaustively covered by tests, and the migration is edge-by-edge with
  the current callers as the checklist.
- Per-Task locking adds a serialization point; contention is limited to
  operations on the *same* Task, which are already logically exclusive.
- Aligns with and extends ADR-0001 (in-process coordination only); introduces no
  durable lease, CAS ref, or journal.

## Supersedes

None. Extends ADR-0001 (execution model, states, and the in-process merge mutex).
