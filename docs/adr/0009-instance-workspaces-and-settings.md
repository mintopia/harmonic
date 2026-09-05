# Decision: Instance, Workspaces, settings and configuration

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

**Amended by ADR-0022** (config layering), by explicit owner override, on three
clauses: (1) "sole home of configuration / no out-of-band seed" — a shipped
`baseline.yaml` is now the seed and the global block becomes a sparse patch over
it; (2) "harnesses, model prices, `modelInfo` stay global" as separate keys —
`prices` and `modelInfo.contextWindow` fold into per-harness model entries and
`modelInfo.cacheTtlSeconds` becomes harness `cacheWarmSeconds`; (3) the "source
inline" display becomes the muted / modified / revert visual across a third
(baseline) layer. Everything else here stands.

**Terminology amended (2026-09-05)**, by explicit owner override: the **Machine
Ceiling** is renamed the **Host Ceiling** — the glossary is the living source of
truth. The body below keeps the original name as a record of the decision as
made; the concept is unchanged.

## One instance, many Workspaces

A **Workspace** is a named Working Directory (a repo root, unique by absolute
path) that owns its own board of Tasks and Conversations, its own execution
settings, and its own tracker poll loop. One Harmonic instance hosts many
Workspaces from one data directory and one SQLite database; the app owns the
"one instance per data dir" invariant. Tasks, Attempts, and Conversations
carry a `workspaceId`; `workingDir` is snapshotted onto the row at creation so
history stays intact when a Workspace is renamed, repointed, or deleted.

- **One Auto-Runner** walks all Workspaces — not one scheduler per Workspace
  racing on one DB. It honours each Workspace's concurrency cap under a
  global **Machine Ceiling** (a Workspace override is clamped to the
  ceiling); total concurrency can never breach the ceiling.
- Auto-Runner enable is per-Workspace, gated by a **global master switch**: a
  Task runs only when the master is on and its Workspace is enabled — the
  master is the one-click fleet-wide pause.
- The firehose stays a single WebSocket; every payload carries `workspaceId`
  and clients filter to the active Workspace.
- Machine-level settings (harnesses, model prices, operator password,
  notification channels, `modelInfo`) stay global.

## One scope-declaring settings schema

Every setting declares, in one registry, its **scope** (`global-only` or
`overridable`) and its control (type, label, help). The resolver and both
settings surfaces derive from that declaration, so parity is a property of
construction, not of keeping two forms in sync by hand.

- **Universal three-state inheritance.** Every overridable setting is
  inherit / on / off with `null` = inherit, resolved centrally
  (`workspace ?? global` at read time). An explicit workspace value wins in
  both directions — workspace-on beats global-off and vice versa. No
  cross-key master gate.
- **Compound overrides decompose into independently-inheritable scalars.**
  The critic is four fields (`reviewEnabled`, `reviewPrompt`, `reviewModel`,
  `reviewHarness`); the drive block decomposes likewise. No `{off:true}`
  sentinel, no ordering-sensitive union — that entire hazard class is
  deleted, not patched.
- **The command verifier overrides at the list grain**: inherit (`null`),
  override (the workspace's own full array), or off (an explicit empty
  array). No per-command inheritance.
- **Task defaults resolve `Task ?? Workspace ?? global` on every read**,
  never snapshotted at creation — retargeting a board's model is one
  Workspace edit, while a pinned Task stays put. An execution reads its
  Task's resolved values when it spawns, so later edits never rewrite a
  finished execution's history.
- **Chat defaults are their own overridable pair** (`chat.harness`,
  `chat.model`), resolved at Conversation creation and locked there — the
  operator often talks to a different agent than the one running the board.
- **Working Directory is Workspace identity, not a default.** Tracker
  enable/interval are Workspace-only (ADR-0004).
- **Validate the resolved config, never silently skip** (ADR-0003): invariants
  like "enabled ⇒ has prompt + model" are judged on the resolved values, and
  an effectively-enabled-but-unrunnable verifier is a loud visible state.
- **One schema-driven, tabbed engine renders both surfaces** (General /
  Execution / Verification / Prompts / Integrations / Security); the
  workspace surface is the same renderer with the inherit layer on and
  global-only tabs hidden. Each field shows its resolved value and source
  inline ("On · inherited from global"). All values flow through one
  buffered save bar; only genuine side-effect actions stay immediate.

## Configuration lives in a YAML file

Configuration — the global settings and every Workspace's setting overrides —
lives in a single `settings.yaml` in the data directory, beside `harmonic.db`
(#391). It is the sole home of configuration; there is no out-of-band seed and
no second copy in the DB. The settings API and UI read and write this file; a
UI edit rewrites it. The DB keeps only Workspace *identity* (id, name, Working
Directory, tracker settings) — the override values that were nullable columns
on `workspaces` moved to the file, keyed by Workspace id, and the resolution
model is unchanged (`workspace ?? global` at read time; `null`/absent = inherit).

- **Loud on load, never silent.** The file is parsed and schema-validated with
  the same zod schemas that guard the API (`appConfigSchema` for the global
  block, the Workspace-overrides schema per entry). A malformed file fails the
  boot with a legible error naming the file; it never silently reverts to
  defaults and buries an operator's mistake.
- **On-disk edits are picked up.** A hand-edit to the file is reloaded on the
  next read (a throttled mtime check), so the operator can edit the YAML
  directly, not only through the UI.
- **Clean break, no migration** (ADR-0007): the old DB settings storage is
  dropped, not converted — the `config` row and the `workspaces` override
  columns go away. Settings start from defaults; the operator hand-fills the
  YAML once if they want non-defaults. Nothing worth keeping lived only in the
  DB.
- Telemetry config stays the one deliberate exception — `OTEL_*` env/CLI only,
  resolved at process init, never in the settings file (ADR-0010). The operator
  password is a credential, not settings, and stays in the DB `settings` table
  (it is set through the change-password flow, not hand-edited).
- Parsing YAML adds one dependency, `yaml`.

## Consequences

- New overridable settings must be declared in the schema (and both WS/REST
  zod schemas, for parity tests) — the schema is where parity is enforced.
- Execution-model bounds that survive the reset (`maxAttempts`,
  `contextReuseThreshold`, `merge.conflictResolveTurns`,
  `merge.postMergeCheck`, guardrail defaults) are ordinary overridable
  settings in this schema.

## Absorbed at the reset

Pre-reset 0008 in full, 0044 in full, 0012's surviving resolution model
(read-time resolution, two-level cap, master switch, chat defaults,
Working-Directory-is-identity), 0004. See README.md for the mapping.
