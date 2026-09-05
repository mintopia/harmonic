# Spec: Multiple Workspaces in a single instance

Design settled via `/grill-with-docs`. Domain: [CONTEXT.md](../../CONTEXT.md)
(**Workspace**, **Host Ceiling**). Decision: [ADR-0008](../adr/0008-workspaces-in-a-single-instance.md).

## Model (settled)

- A **Workspace** = a named Working Directory, unique by absolute path. Owns a
  board of Tasks + Conversations bound to that dir, its own execution config,
  and its own Tracker poll loop.
- **Per-Workspace config:** Task defaults, Auto-Runner (`enabled` + `maxConcurrentRuns`),
  Tracker (`enabled` + `pollIntervalSeconds`), Drive (`prompt`/`mergeFate`/`autoRetry`),
  Verification (`autoAccept`, per ADR-0021 — a passing verifier's auto-accept).
- **Global config:** Harnesses, model prices, operator password, Notification
  Channels, `modelInfo`, `conversationIdleTimeoutMinutes`, **Host Ceiling**.
- **Concurrency:** each Workspace fills to its own cap; total never exceeds the
  Host Ceiling.
- Always ≥1 Workspace; last cannot be deleted; delete is guarded (no in-flight
  work) + cascades to Tasks/Runs/Conversations.
- Tasks/Conversations/Runs get `workspaceId`; `workingDir` stays as a
  creation-time snapshot. Per-Task overrides (harness/model/isolation/priority)
  remain, pre-filled from the Workspace's defaults; `workingDir` is no longer a
  free per-Task field.

## Stages (each a self-contained commit, tests green)

### Stage 1 — Schema + migration
- `workspaces` table: `id`, `name`, `workingDir` (unique), `config` (JSON:
  per-workspace execution config), `createdAt`, `updatedAt`.
- Add nullable `workspaceId` FK to `tasks`, `conversations` (runs inherit via
  task; add only if a direct query needs it).
- Migration: create the **default** Workspace from the current
  `settings.config.defaults.workingDir`; move the per-workspace fields out of
  the global config blob into it; backfill `workspaceId` on every existing
  Task/Conversation; then make `workspaceId` NOT NULL.
- Trim global config schema; add `hostCeiling`.

### Stage 2 — Domain + config
- `WorkspaceService` (CRUD, guards: unique path, last-can't-delete,
  delete-requires-idle + cascade).
- Split `ConfigStore` → global config + `workspace.config` accessor.
- `TaskService`/`ConversationService`: resolve execution from the Task's
  Workspace config (not global defaults); stamp `workspaceId` + `workingDir`.

### Stage 3 — API
- `/api/workspaces` CRUD; global config stays `/api/config`; per-workspace
  config on `/api/workspaces/:id`.
- `workspaceId` filter on task/run/conversation lists; every serialized
  payload carries `workspaceId`.
- Firehose unchanged (single WS); payloads carry `workspaceId`.

### Stage 4 — Execution
- One Auto-Runner: walk Workspaces, fill each enabled one to its cap under a
  shared Host-Ceiling counter.
- Tracker: one poller per tracker-enabled Workspace; create/tear-down on
  Workspace add/remove and tracker-toggle.

### Stage 5 — Web UI
- Sidebar **Workspace switcher** + active-workspace state; Board/Table/Stats
  and the status strip (auto-runner toggle, running count, cost) scope to it.
- **New Workspace** flow: pick dir + name → config seeded from built-in
  defaults.
- Settings split into **Workspace** (active ws) and **Global** sections.
- Delete-workspace flow with the idle guard + confirmation.

### Stage 6 — Docs + polish
- README run notes (one instance, many workspaces); OpenAPI examples; the
  data-dir lock guard (refuse a second instance on a held data dir) if not
  already done.

## Non-goals (v1)
- Cross-workspace "all" aggregate view.
- Per-channel workspace filtering (channels fire on all, name in the message).
- Cloning config from another workspace on create.
- Full per-workspace harnesses/prices (those stay global).
