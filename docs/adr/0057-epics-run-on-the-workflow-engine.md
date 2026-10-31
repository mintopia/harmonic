# Decision: Epics run on the Task Execution Workflow engine through a bundled Epic workflow

Status: accepted
Date: 2026-10-31

Epics execute through the same engine as Tickets (ADR-0053). A bundled
workflow `epic`, declaring `subject: epic`, expresses what ADR-0028 hardcodes
today: Epic Pre-Merge Verification, the bounded resolve loop, and the Merge of
the Integration branch into the base. An Epic's workflow comes from a global
Epic workflow setting or a Workspace override, never from labels. Existing
Epic verification settings migrate into "Migrated Epic (…)" workflows at first
boot, and the old Epic verification code and settings UI are deleted. Amends
ADR-0053's Epic deferral; replaces ADR-0028's Epic verification and
resolve-loop mechanics. Issue #928, epic #887.

## Context

ADR-0053 v1 covered Tickets and Native Tasks and deferred Epics: "Epics will
run the same engine with a separate built-in Epic workflow". Until then the
Epic path runs its own code (`EpicVerificationRunner`, `EpicResolutionRunner`,
`verifyEpicIntegration`, `resolveEpicVerification`,
`composeEpicResolvePrompt`) from its own settings: `verify.epic.*` globally,
the Workspace `epicPreMergeCommands` and `epicPreMergeCritics` overlays, the
Epic resolve prompt, and the global `maxAttempts` (ADR-0028, ADR-0037). An
instance therefore has two sources of verification settings (ADR-0055), and
an Epic's process cannot be changed without a code change.

## Decision

### The bundled `epic` workflow

- **Same engine, same invariants.** ADR-0053's five engine invariants,
  control flow, expressions, Escalation resume and versioning apply unchanged.
  An Epic snapshots its workflow version when its Epic Pre-Merge Verification
  starts.
- **`subject: epic`.** A workflow declares the subject it runs on. Bundled
  `epic` declares `subject: epic`; Ticket workflows declare (or default to)
  `subject: ticket`.
- **Steps.** One `attempts:` block holds, in order: an `agent` resolve step
  with `if: attempt.number > 1`, the verify `command` steps, and the `critic`
  steps. After the block, `merge` merges the Integration branch into the base
  with the merge-commit policy (ADR-0001, ADR-0040), followed by the
  post-merge check in the merge's administrative worktree (ADR-0039), ticket
  close and branch retirement as `cleanup`.
- **The inverted loop is kept.** The resolve step is skipped on pass 1, so a
  clean first pass runs no agent, as ADR-0028 requires. A `fail` or
  `inconclusive` starts the next pass, where the resolve agent runs in the
  Epic's worktree on `epic/<ref>` with the failing steps' feedback, then the
  full verify list re-runs. Only the agent commits (invariant 1).
- **The bound is `attempts.max`.** The Epic loop is bounded by the Epic
  workflow's `attempts.max`, not the global `maxAttempts` setting, which #926
  removes. Exhausting it escalates the Epic through the same surface as a
  Ticket.
- **The workflow starts when the integrate gate opens**: every Member complete
  and no blocked-by hold (ADR-0039, ADR-0051). The gate stays in code.

### Epic Attempts match Ticket Attempts

- **One Epic Attempt per run.** Each pass of the `attempts:` block is a
  step-run attempt (`workflow_step_runs.attempt`), recorded against the Epic.
- **Same presentation.** The Epic page shows the step list and Attempt
  selector the Ticket page uses.
- **History stays readable.** Epic Attempt rows created before the cutover,
  one row per verify pass, are kept and shown as history.

### Assignment

- **A global Epic workflow setting and a Workspace Epic workflow override**,
  whose unset state is "Use global default".
- **Subject must match.** Only workflows declaring `subject: epic` can be
  chosen for Epics, and Ticket workflows cannot; a save choosing the wrong
  subject is refused, in either direction.
- **No Workflow Labels and no per-Epic choice.** Workflow Labels and the
  operator's per-Ticket choice do not apply to Epics.
- **The source is visible.** The Epic page states whether the workflow came
  from the Workspace Epic workflow or the global Epic workflow. UI mockup:
  `docs/mockups/workflows/workflows.html` section 7.

### Migration

- **ADR-0055's rules, for Epic settings.** At first boot, `verify.epic.*`,
  the Workspace `epicPreMergeCommands` and `epicPreMergeCritics` overlays, the
  Epic resolve prompt and the attempts limit convert into a
  "Migrated Epic (global)" workflow, set as the global Epic workflow, and a
  "Migrated Epic (<Workspace>)" workflow for each Workspace whose overrides
  change anything, set as that Workspace's override.
- **Same safeguards.** A setting that cannot convert stops the boot (ADR-0042
  rollback); the conversion yields to the event loop between chunks; it is
  idempotent, guarded by its own marker `migration.epic-settings-to-workflows`,
  separate from ADR-0055's `migration.settings-to-workflows`.
- **The old Epic path is deleted after cutover**: `EpicVerificationRunner`,
  `EpicResolutionRunner`, `verifyEpicIntegration`, `resolveEpicVerification`,
  `composeEpicResolvePrompt` and the Epic verification settings UI.

Out of scope: Epic Workflow Labels.

## Considered Options

- **Keep ADR-0028's hardcoded Epic path.** Rejected: two sources of
  verification settings and a process operators cannot edit.
- **One Epic Attempt row per verify pass**, as today. Rejected: Tickets record
  one Attempt per run with passes as step-run attempts; one shape for both
  lets the Epic page reuse the Ticket's step list.
- **Workflow Labels or a per-Epic choice for Epics.** Rejected for now: a
  global setting with a Workspace override covers the known need. Epic
  Workflow Labels can follow.
- **Let any workflow run on an Epic.** Rejected: a Ticket workflow's `rebase`
  and implementation steps have no meaning on an Integration branch, and a
  save-time subject check catches the mistake early.
- **Reuse ADR-0055's migration marker.** Rejected: instances that already ran
  the Ticket migration must still run the Epic one.

## Consequences

- One engine, editor and library cover Tickets, Native Tasks and Epics, and
  operators can edit an Epic's process; ADR-0055's two sources of
  verification settings end.
- The workflow schema gains `subject`, and the save check gains the subject
  rule for both the library and the assignment settings.
- Step runs gain an Epic owner, and the Epic page reuses the Ticket step-list
  components.
- An Epic's attempts bound now differs per workflow rather than following the
  global `maxAttempts`.

## Supersedes

ADR-0028's Epic Pre-Merge Verification, resolve-loop and `verify.epic.*`
configuration mechanics (its inverted-loop rule stands, now as the resolve
step's `if:`). ADR-0028's Task stages were already replaced by ADR-0053.

Amends ADR-0053 ("v1 covers Tickets and Native Tasks" and "Epics keep
ADR-0028 until the Epic workflow ships") and ADR-0055 (Epic settings now
migrate, with their own marker).
