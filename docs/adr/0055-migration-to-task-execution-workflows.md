# Decision: Existing execution settings migrate to Task Execution Workflows at first boot, and the old keys are removed in a later release

Status: accepted
Date: 2026-10-30

Amended by ADR-0057 (2026-10-31): Epic verification settings now migrate into "Migrated Epic (…)" workflows under their own marker.

On the first boot of the release that introduces Task Execution Workflows
(ADR-0053), Harmonic converts today's execution settings into workflows: a
"Migrated (global)" workflow set as the global default, and one
"Migrated (<Workspace>)" workflow for each Workspace whose overrides change
anything. Edited Prompt Fragments become Prompt Library entries (ADR-0054).
A setting that cannot convert stops the boot so ADR-0042's boot guard rolls
back. The old Ticket-side settings UI and code are removed in that release;
Epic verification settings stay until the Epic workflow ships. The old
Ticket-side config keys are left in place, ignored, for at least one release so
a rollback (ADR-0042) still finds them, and are deleted in a separate later
release cut by a human.

## Context

Execution behaviour today lives in settings layered global → Workspace
(ADR-0009, ADR-0022): verify command lists and critic lists (ADR-0028,
ADR-0031, ADR-0037), `maxAttempts`, `continueAttempts`, the Merge Fate, and
edited Prompt Fragments (ADR-0047). ADR-0053 moves all of this into
workflows and ADR-0054 replaces Fragments with the Prompt Library. An operator
who has tuned these settings must keep the same behaviour after upgrading
without re-entering it. A managed upgrade can roll back to the previous release
(ADR-0042), and that release reads only the old keys.

## Decision

- **Runs once, at first boot on the new version.**
- **"Migrated (global)"** is built from the global settings: verify commands,
  critics, `maxAttempts`, `continueAttempts`, the Merge Fate, and the prompt
  each step used. It is set as the global default workflow.
- **"Migrated (<Workspace>)"** is built for each Workspace whose overrides
  change anything, from that Workspace's resolved settings, and set as that
  Workspace's default. A Workspace whose overrides change nothing keeps the
  global default.
- **Edited Fragments become Prompt Library entries**, and the migrated
  workflows reference them. Unedited Fragments map to the bundled prompts.
- **A setting that cannot convert stops the boot.** Harmonic refuses to start
  with an error naming the setting, so the ADR-0042 boot guard rolls back to
  the previous release.
- **Ticket-level overrides become Ticket `vars:`** on the Ticket's migrated
  workflow.
- **Tickets working at upgrade** snapshot their migrated workflow. Crash
  recovery resumes each at the step matching its last recorded Step type.
- **Only Ticket-side settings migrate.** Epic verification settings (ADR-0028's
  Epic lists and Epic critics), their keys and their UI are kept until the
  Epic workflow ships (ADR-0053).
- **The old Ticket-side settings UI and code are removed** in this release.
  Nothing reads those keys any more.
- **Two-release key removal.** The old Ticket-side config keys are left
  untouched and ignored for one release, so an ADR-0042 rollback to the
  previous release finds its configuration intact. Their deletion is a
  separate later release, gated on a human release cut.

## Considered Options

- **Delete the old keys in the migrating release.** Rejected: a rollback would
  start the previous release without its execution settings.
- **Keep the old settings live alongside workflows.** Rejected: two sources
  of truth for the same behaviour, and ADR-0053 makes the workflow the whole
  process.
- **Migrate every Workspace to its own workflow.** Rejected: Workspaces that
  override nothing would each get an identical copy that drifts from the
  global one when the operator edits it.
- **Ship only the bundled default and ask operators to recreate their
  settings.** Rejected: an upgrade must not change how a tuned instance runs.
- **Skip a setting that cannot convert and show a banner.** Rejected: it
  silently weakens verification. Refusing to start hands the problem to the
  boot guard, which restores the release that understood the setting.
- **Migrate Epic verification settings now.** Rejected: Epics do not run on
  Task Execution Workflows until the Epic workflow ships, so there is nothing
  to migrate them into.

## Consequences

- An instance upgrades with the same behaviour, now expressed as editable
  workflows visible in the library.
- Settings changed on the new release do not reach the old keys. A rollback
  after such edits returns to the configuration as it stood at upgrade time,
  which matches ADR-0042's database restore.
- The deletion of the old keys needs its own release note and migration, and
  waits for a human to cut that release.
- An instance with a setting the migration cannot express cannot upgrade until
  the operator changes that setting on the previous release.
- Until the Epic workflow ships, the instance has two sources of verification
  settings: workflows for Tickets and Native Tasks, the kept settings for
  Epics.
- The bundled default workflow is not what a migrated instance runs; operators
  wanting it choose it explicitly.

## Supersedes

None. Implements the transition for ADR-0053 and ADR-0054 under ADR-0042's
rollback contract.
