# Multiple Workspaces in a single instance

A **Workspace** is a named Working Directory (a repo root, unique by absolute
path) that owns its own board of Tasks and Conversations, its own execution
settings (Task defaults, Auto-Runner, Tracker, Drive), and its own Tracker
poll loop. One Harmonic instance hosts many Workspaces from one data
directory and one SQLite database. Execution settings are per-Workspace; machine-level
settings (Harnesses, model prices, operator password, Notification Channels)
stay global.

We chose this over the previous de-facto model, **one instance per project,
isolated by `--data-dir`**, because that model has no guard rails: nothing
stops a second instance booting on the same data directory, and when one
does, its crash-recovery sweep marks the other's running Runs `interrupted`.
Isolating projects meant remembering a distinct `--data-dir` *and* `--port`
per project, with no in-app way to see or switch between them. Folding
Workspaces into one instance gives per-project boards, settings, and
concurrency with a single process and database, and lets the app own the
"one instance per data dir" invariant instead of leaving it to the operator.

## Considered options

- **One instance per data dir (rejected).** Simple schema, but the shared-DB
  footgun above, and no cross-project view. Kept only as the escape hatch for
  genuinely separate machines/users.
- **N schedulers, one per Workspace (rejected).** Racing on one SQLite DB and
  duplicating the fill loop. We use **one** Auto-Runner that walks Workspaces,
  honouring each Workspace's cap under a global **Machine Ceiling**.

## Consequences

- Tasks, Runs, and Conversations gain a `workspaceId`; `workingDir` stays on
  the row as a creation-time snapshot (history integrity when a Workspace is
  renamed, repointed, or deleted).
- Config splits: a per-Workspace `config` (defaults, Auto-Runner, Tracker,
  Drive, `agentReview`) and a trimmed global config (Harnesses, prices,
  channels, `modelInfo`, idle-timeout, Machine Ceiling).
- One Tracker poller per tracker-enabled Workspace, lifecycle tied to the
  Workspace. Migration folds the existing config + all Tasks/Conversations
  into one auto-created **default** Workspace built from today's
  `defaults.workingDir`.
- The firehose stays a single WebSocket; every payload carries `workspaceId`
  and clients filter to the active Workspace.
