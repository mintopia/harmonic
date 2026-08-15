# Resolved Tracker is derived in-memory, not a persisted column

The Resolved Tracker (issue #83) — which tracker a Workspace's repo declares, or
why it can't resolve — is computed by resolving `docs/agents/issue-tracker.md`
and cached in the `TrackerPollerManager` (`resolved: Map<workspaceId,
ResolvedTracker>`), then merged into the workspace API response at serialize
time. It is **not** a column on the `workspaces` row.

Resolution is a pure function of repo files, not authored Workspace state. It
already had to move into the manager's `sync()` regardless: the "enabled but
unresolvable ⇒ no poll loop" guard (CONTEXT.md, Q6b) needs the resolution result
to decide whether to start a poll loop, so the manager is the one place that both
gates the loop and knows the outcome. Caching it there — beside the poller's own
in-memory scan cache (`lastScan`, `urlByRef`) and surfaced the same way task
`url`/`mapTitle` already are (`server/serialize.ts`) — keeps derived tracker
state in one tier instead of splitting it across a DB column.

## Considered options

- **Persist a `resolved_tracker` column on `workspaces` (rejected).** `GET
  /workspaces` returns raw rows, so a column would flow through with no serialize
  step. But it needs a migration, and a persisted value is a staleness trap: the
  repo's declaration can change (or the repo move) while the server is down, so
  the stored value would be wrong until the next poll rewrites it — state that
  must be recomputed on boot anyway. Persisting derived data buys nothing here.
- **Derive in-memory in the poller manager, merge at serialize time (chosen).**
  No migration, no staleness: every read reflects the last resolution. Matches
  how the poller already holds `lastScan`/`urlByRef` and how `serialize.ts`
  merges `urlFor`/`titleForMap` into task responses.

## Consequences

- `resolveTracker(repoRoot)` (`tracker/adapter.ts`) is the non-throwing sibling
  of `resolveTrackerAdapter`, returning a structured `ResolvedTracker`
  (`{ok:true, name, label}` or `{ok:false, code, reason}`); failure codes come
  from a typed `TrackerResolutionError` so callers branch on a code, not a
  message string.
- `TrackerPollerManager.sync()` is now async: it resolves each tracker-enabled
  Workspace before deciding whether to start its loop, and callers
  (`routes/workspaces.ts`, the boot `onListen` hook) `await` it.
- The cache is set on `sync()` and refreshed by the manual `pollNow()` refresh;
  it is dropped when a Workspace disables tracking or is deleted, so a tracking-
  off Workspace surfaces a `null` Resolved Tracker.
- The value is ephemeral — after a restart it is empty until the boot `sync()`
  recomputes it, which is the intended source of truth (the live repo), not a
  stored snapshot.
