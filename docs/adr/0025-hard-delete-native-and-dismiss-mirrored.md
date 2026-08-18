# Hard-delete removes a Task outright; a mirrored delete tombstones its ref

Issue #162. `cancelled` has been doubling as a soft-delete: the only removal path
was Cancel, which keeps the record forever. A Task that was executed, needed
rejecting, and got superseded by a duplicate lingers in `cancelled`, cluttering
the board with no clean way to remove it. We add a first-class **hard-delete**,
distinct from Cancel:

- **Cancel** — abandon deliberately, keep the record (the existing terminal state).
- **Delete** — remove the Task entirely, along with its Runs, Usage, and
  Dependency edges.

Delete is guarded to a Task that is **not currently running** (`state !== 'running'`),
matching Workspace deletion's guard. The REST/MCP surface first calls
`runner.cancelForTask(id)` to tear down any parked (awaiting-review) harness
process, then `TaskService.delete(id)` purges the rows in one transaction.

## The mirrored-Task question

A mirrored Task is bound 1:1 to a tracker issue and re-created every poll by
`upsertMirrored`, keyed on `(workspaceId, trackerRef)`. A naive local delete of a
mirrored Task whose issue still exists is silently resurrected on the next poll.
The ticket requires deletion to be defined so a re-poll cannot bring it back.

**Chosen: delete the row outright for both origins, and for a mirrored Task also
write a tombstone on `(workspaceId, trackerRef)` into a new `tracker_dismissals`
table that the poller consults before re-mirroring.** A mirrored delete is a
**Dismiss**: the operator declares "stop mirroring this issue here." The tombstone
is durable and per-Workspace (two repos sharing an issue number dismiss
independently, mirroring the `tasks_tracker_ref_idx` scope). `mirrorScan` skips any
scanned ticket whose ref is tombstoned, so the Task never comes back.

## Considered options

- **Keep the mirrored row in a new hidden `dismissed` state (rejected).** Adds a
  ninth Task state and forces every board-column, graph, list, and Auto-Runner
  query to learn to exclude it — exactly the "hidden lingering row" problem the
  ticket is trying to end, now under a new name. It also re-introduces a
  soft-delete for the mirrored half while the native half is a true delete: two
  representations of "gone".
- **Delete outright for native, tombstone the ref for mirrored (chosen).** One
  representation of "gone" for both origins — the row is *deleted*, so every
  existing board/graph/list/Auto-Runner query already excludes it with **no
  change** (a deleted row simply isn't there). The only mirror-specific addition
  is the tombstone table the poller reads. Acceptance criterion "not counted in
  any board column or graph" falls out for free.
- **Restrict mirrored delete to issues already gone from the tracker (rejected).**
  Makes the common case — "this mirror is in a mess, remove it" — impossible while
  the issue is open, which is precisely when an operator wants it gone. The poll
  never prunes vanished issues today either, so this would leave the messy-state
  case with no remedy at all.

## Consequences

- New table `tracker_dismissals (id, workspace_id, tracker_ref, dismissed_at)` with
  a unique index on `(workspace_id, tracker_ref)` — migration `0037`. It is the
  only schema change; a delete is otherwise pure row removal.
- `TaskService.delete(id)` cascades in one transaction, children first (runtime
  runs with `foreign_keys = ON`): every table with an FK to the Task's Runs
  (`run_events`, `run_facts`, `landing_journal`, `turn_queue`,
  `work_context_leases`, `verification_attempts`, `guardrail_events`, plus scoped
  `api_keys` rows) → `runs` → the Runs' orphaned `sessions` → `task_channels` →
  `task_dependencies` (both directions) → null out any `reattempt_of` pointing at
  this Task (a re-attempt becomes standalone rather than dangling) → the `tasks`
  row → the tombstone (mirrored only). Former dependents are then re-derived
  (`blocked → ready`), matching how every other edge change re-derives.
- A new `task_removed` bus event ( `{ id }` ) is broadcast so a live board drops the
  Task immediately; the re-derived dependents ride the existing `task_changed`.
- Un-dismiss (bringing a tombstoned mirror back) is out of scope. Deleting the
  tombstone row is the manual escape; a first-class un-dismiss action can follow if
  operators need it.
- Cancel/uncancel are unchanged. A `cancelled` Task remains a kept record; Delete
  is the way to actually remove one.
