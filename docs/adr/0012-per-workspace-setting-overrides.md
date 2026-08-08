# Per-workspace setting overrides with global-default inheritance

Settings split into three scopes: **global-only** (machine-level:
harnesses, prices, notifications, permission rules, security, the drive
prompt, the Machine Ceiling), **workspace-only** (a Workspace's identity and
its own state: name, Working Directory, tracker enable/interval,
Auto-Runner enable, delete), and **global-default-with-per-workspace-override**
(Task defaults — harness, model, Isolation Mode, Priority — and the
Auto-Runner concurrency cap). An overridable setting stores `null` on a
Workspace to mean *inherit*; a non-null value overrides the global default.
The effective value is resolved at read time (`workspace value ?? global
default`). Two surfaces expose this: a **global settings page** (header icon)
holding the defaults and machine settings, and a **per-workspace settings
page** (left-rail nav item, scoped to the selected Workspace) showing each
overridable field with its inherited value and an explicit override toggle.

We chose per-workspace overrides because one operator runs Workspaces with
genuinely different needs (a fast repo wanting a higher cap, a repo pinned to
a different Harness) and a single global config forced one shape on all of
them. Inheritance keeps the common case cheap — a Workspace configures
nothing and tracks the global default as it changes — while making divergence
explicit and reversible (reset to default clears the override). This
reconciles the code to the domain model `CONTEXT.md` already described (the
Machine Ceiling as the global cap, a Workspace's own concurrency cap beneath
it), which until now was aspirational: the code had a single global
`maxConcurrentRuns` and no per-workspace scope at all.

## Considered options

- **Keep everything global (rejected).** Simplest, no override plumbing, but
  can't express per-Workspace divergence — the actual need that prompted this.
- **Per-workspace copy of every setting, no inheritance (rejected).** A new
  Workspace would snapshot the defaults and then drift silently as the global
  default changed; there'd be no "track the default" state and no single place
  to shift a fleet-wide default.
- **Nullable override + read-time resolution (chosen).** `null` = inherit is a
  cheap, honest representation; the effective value is always derivable and the
  UI can show inherited-vs-overridden without extra state.

## Consequences

- Overridable settings become nullable per-Workspace columns; reads resolve
  `workspace ?? global`. Task defaults are snapshotted onto a Task at creation
  as today, so a resolved value is captured once and a later default change
  never shifts a finished Run's record.
- The Auto-Runner cap is now two-level: a global **Machine Ceiling** and an
  optional per-workspace cap that can never exceed it (a Workspace override is
  clamped to the ceiling). Total concurrency across all Workspaces still
  cannot breach the ceiling.
- Auto-Runner *enable* is now per-workspace, gated by a global master switch in
  the header: a Task runs only if `master ∧ workspace-enabled`. The header
  switch stays the one-click fleet-wide pause.
- Working Directory leaves the global Task defaults — it is Workspace identity,
  not a default.
