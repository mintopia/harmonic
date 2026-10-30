# Decision: Existing execution settings migrate to Task Execution Workflows at first boot, and the old keys are removed one release later

Status: accepted
Date: 2026-10-30

On the first boot of the release that introduces Task Execution Workflows
(ADR-0053), Harmonic converts today's execution settings into workflows: a
"Migrated (global)" workflow set as the global default, and one
"Migrated (<Workspace>)" workflow for each Workspace whose overrides change
anything. Edited Prompt Fragments become Prompt Library entries (ADR-0054).
The old settings UI and code are removed in that release. The old config keys
are left in place, ignored, for one release so a rollback (ADR-0042) still
finds them, and are deleted in the release after.

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
- **The old settings UI and code are removed** in this release. Nothing reads
  the old keys any more.
- **Two-release key removal.** The old config keys are left untouched and
  ignored for one release, so an ADR-0042 rollback to the previous release
  finds its configuration intact. The release after deletes them.

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

## Consequences

- An instance upgrades with the same behaviour, now expressed as editable
  workflows visible in the library.
- Settings changed on the new release do not reach the old keys. A rollback
  after such edits returns to the configuration as it stood at upgrade time,
  which matches ADR-0042's database restore.
- The deletion of the old keys needs its own release note and migration in the
  release after.
- The bundled default workflow is not what a migrated instance runs; operators
  wanting it choose it explicitly.

## Open questions

- What happens when a setting has no workflow equivalent or the conversion
  fails at boot: refuse to start, or skip and record it.
- Epic verification and integration settings: Epics stay on ADR-0028 until the
  Epic workflow ships (ADR-0053), so whether their keys and settings UI are
  kept, and how they are removed later, is not decided.
- Whether in-flight Tickets at upgrade time snapshot the migrated workflow or
  finish under the previous code path.
- How Ticket-level operator overrides of today's settings, if any, are carried
  into Ticket-level `vars:`.

## Supersedes

None. Implements the transition for ADR-0053 and ADR-0054 under ADR-0042's
rollback contract.
