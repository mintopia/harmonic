# Decision: Task Execution Workflows define a Ticket's whole execution process

Status: accepted
Date: 2026-10-30

A **Task Execution Workflow** is an operator-editable definition of everything
that happens to a Ticket while it is *working*: its steps and their order, how
each outcome branches, the bounded Attempt loop, where an Escalation action
resumes, Merge, and what runs after Merge. It is written in YAML, shaped like a
GitHub Actions workflow or an Ansible playbook, and composed from a closed set
of built-in **Workflow Actions**. The engine keeps five invariants no workflow
can break. The process Harmonic runs today ships as the bundled default.
Supersedes ADR-0038's hardcoded resume table; amends ADR-0020, ADR-0028 and
ADR-0037 as stated below.

## Context

An Attempt runs a fixed sequence in code: the Rebase Step, the Implementation
Step, the Verification Steps, the Critics, then Merge and close-out
(ADR-0001, ADR-0038). Operators shape it only through scattered settings:
ordered verify command lists and critic lists (ADR-0028, ADR-0031, ADR-0037),
`maxAttempts`, `continueAttempts`, the Merge Fate, and Prompt Fragments
(ADR-0047). Asking for a different process, such as a security Critic only on
labelled Tickets, a second agent turn that writes tests first, or opening a PR
instead of merging, means a code change. ADR-0038's Accept rule is a hardcoded
table keyed on four Step types, so any new Step needs a new row.

The term "workflow" already names the `tasks.workflow` column
(`wayfinder` | `implement`), which says what kind of work an issue is, not how
it is executed.

## Decision

### Name and scope

- **Task Execution Workflow** is the name. The existing `tasks.workflow`
  concept is renamed **Issue Workflow**; its column, types and UI follow.
- **The workflow defines the whole execution process**: steps, order, outcome
  branching, the Attempt loop, Escalation resume, Merge, and post-merge work
  (the post-merge check, ticket close, cleanup).
- **Task states stay fixed in code.** `draft`, `ready`, `working`, `paused`,
  `escalated`, `done` and `cancelled`, and ADR-0020's transition enforcement,
  are unchanged. The workflow owns everything that happens inside them.
- **v1 covers Tickets and Native Tasks.** Epics will run the same engine with
  a separate built-in Epic workflow; that is deferred to a later epic. Until
  then Epic verification and integration keep ADR-0028 and ADR-0039.

### Engine invariants

A workflow that would break any of these is refused at save:

1. **Only the agent commits** to the Ticket branch (ADR-0001).
2. **Merge always uses the merge-commit policy** (ADR-0001, ADR-0040).
3. **Guardrails and branch ownership always apply** (ADR-0002).
4. **Every attempt loop is bounded**, so the process ends in `done` or
   `escalated`.
5. **An unavailable Harness escalates.** There is no substitution with another
   Harness.

### Workflow Actions

- **A closed, built-in set**, with no plugins in v1: `rebase`; `agent` (a
  prompt, Harness and Model); `command` (a shell verify command); `critic`;
  `merge`; `open-pr`; `artifact`; `post-merge-check`; `close-ticket`;
  `comment`; `cleanup`. The Merge Fates become Workflow Actions (`merge`,
  `open-pr`, `artifact`).
- **`run:`** executes an arbitrary shell command in the worktree.
- **Every step reports an outcome**, one of `pass`, `fail`, `inconclusive` or
  `conflict`, plus outputs.
- **Critics and verifications are steps.** There is no separate Critic library.
  A critic step has its own Harness, Model and prompt (by Prompt Library code
  or literal text, ADR-0054). The Critic's JSON verdict contract stays appended
  by the engine, which parses the reply.

### Control flow

- **Steps** carry `id`, `uses`, `with` and `if`. `if:` reads
  `steps.<id>.outcome` and `steps.<id>.outputs`.
- **`parallel:`** groups steps that run together, such as Critics.
- **One bounded `attempts:` block**:
  `attempts: { max: ${{ vars.maxAttempts }}, steps: [...] }`. A failure inside
  the block starts the next Attempt; exhausting `max` escalates.
- **No `goto` and no unbounded loops.**

### Variables and secrets

- **Read-only context**: `ticket.*` (title, body, labels, ref), `attempt.*`
  (number, previous verdict, failure reason) and `workspace.*`.
- **`vars:`** declare defaults that a Workspace and a Ticket can override.
- **Step outputs** are readable by later steps.
- **Secrets** are available only through an explicit `secrets.NAME`
  (ADR-0046 Secrets) and are masked in logs.

### Expressions

- GitHub-style `${{ }}`, evaluated by a small safe evaluator: comparisons,
  `&&`, `||`, `contains()`, `startsWith()` and `format()`.
- No JavaScript evaluation, no file access and no network access.
- An invalid expression is refused at save.

### Escalation resumes generically

This replaces ADR-0038's resume table, keyed on Step type, with one rule that
works for any workflow. Escalation keeps its three actions (ADR-0002).

- **Accept** marks the failed step `pass` and continues from the next step.
  Accept at the final step continues to Merge. ADR-0038's other Accept rules
  stand: no re-verify, and a candidate commit is required.
- **Retry** starts a new pass of the `attempts:` block with the counter reset,
  and re-resolves the Workflow Label. ADR-0038's #817 amendment (Retry, Retry
  Now, Harness and Model choice, Session re-use) is unchanged.
- **Close** runs the workflow's cleanup steps.

### Assignment: Workflow Labels

- **Workflow Labels** are tracker labels that pick a Ticket's Task Execution
  Workflow. They are a separate list from Routing Labels and independent of
  Harness and Model.
- **Ordered, first match wins; global list with an additive Workspace
  overlay** (ADR-0037, as for Routing Labels).
- **Precedence**: an operator's explicit choice on the Ticket, then the
  Workflow Label, then the Workspace default, then the global default.
- **Resolved once when the Ticket starts working**, and again on Retry. Never
  re-resolved per Attempt.
- **Not chosen by AI.** The Route Classifier (ADR-0052) picks Harness and
  Model only.

### Interaction with routing

An agent step with no explicit Harness or Model uses the Ticket's route
(ADR-0049, ADR-0052). A step with explicit values, which every Critic has,
ignores routing. The Route Classifier runs once per Attempt, not per step.

### Storage and library

- **Each workflow is its own YAML file in Harmonic's data directory**, with
  import and export as files.
- **Bundled workflows ship in the package**, read-only, and are upgraded with
  Harmonic. **Duplicate** makes an editable copy.
- **One global library.** A Workspace only chooses its default and its Workflow
  Labels.
- **Not read from the repository.**

### Versioning

- A Ticket snapshots the workflow version when it starts working, and an
  in-flight Ticket finishes on that version.
- Edits apply from the Ticket's next Retry.
- The Ticket page shows the workflow and its version.

### Editor (v1)

- A YAML editor with schema validation, inline errors and invariant checks on
  save.
- A live, read-only diagram of the steps and their outcome branches beside it.
- A drag-and-drop block builder that edits the same YAML is a later epic.

## Considered Options

- **An ordered step list with fixed semantics** (operators reorder and add
  Steps; the engine owns the loop, Escalation and Merge). Rejected in favour of
  a full process definition: the requests that motivate this (opening a PR
  instead of merging, conditional Critics, extra agent turns) are about the
  loop and what follows it, not only the order of verifiers.
- **Workflows as files in the repository**, like GitHub Actions. Rejected:
  execution process is operator policy. A merged change in the repository
  should not change how Harmonic runs, what it spends, or whether it merges.
- **Re-resolve the workflow at every Attempt.** Rejected: an Attempt loop that
  changes shape mid-loop has no coherent resume point or attempt count.
  Resolution happens at start and on Retry, the points where the operator has
  restarted the loop.
- **Plugins or operator-written Workflow Actions in v1.** Rejected: a closed
  set keeps the engine invariants checkable. `run:` covers arbitrary shell
  work in the worktree.
- **`goto` or open loops.** Rejected: invariant 4 requires every process to end
  in `done` or `escalated`, which a save-time check can prove only for a single
  bounded `attempts:` block.
- **JavaScript expressions.** Rejected: a workflow is configuration, and its
  expressions get no code execution, files or network.
- **Make Task states part of the workflow.** Rejected: the state machine
  (ADR-0020) is what the board, the Auto-Runner and Escalation rely on.
- **Keep a separate Critic library referenced from workflows.** Rejected: a
  Critic is a step with its own Harness, Model and prompt; a second registry
  would duplicate it.
- **Per-Workspace workflow libraries.** Rejected: one library, with Workspaces
  choosing defaults and Workflow Labels, avoids the same workflow drifting in
  several copies.
- **Ship the drag-and-drop builder first.** Deferred: the YAML is the source
  of truth, and a builder that edits it can follow without a format change.

## Consequences

- ADR-0038's step-type resume table and its `STEP_TYPES`-keyed advance are
  replaced by the generic Accept rule. A new Workflow Action needs no
  Escalation change.
- ADR-0020's transitions are unchanged, but which work runs after Accept and
  Retry now comes from the snapshotted workflow.
- ADR-0028's verify lists and ADR-0037's verifier overlays stop
  governing Tickets and Native Tasks; their content becomes steps in migrated
  workflows (ADR-0055). The ADR-0037 overlay pattern lives on for Workflow
  Labels and Model Options. Epics keep ADR-0028 until the Epic workflow ships.
- The Merge Fate setting, `maxAttempts` and `continueAttempts` stop being
  settings and become steps and `vars:` in workflows (ADR-0055).
- An operator can write a workflow that spends more or verifies less than the
  default. The invariants bound safety (who commits, how Merge works,
  guardrails, termination, Harness availability), not quality.
- `run:` puts arbitrary shell in operator hands, as verify commands already do.
- Every rename from `workflow` to Issue Workflow touches the schema, API types
  and UI.

## Open questions

- Whether `inconclusive` inside the `attempts:` block counts as a failure that
  starts the next Attempt (ADR-0003 burns an Attempt on it today), or only
  when the workflow's `if:` says so.
- What a `fail` outcome does in a step outside the `attempts:` block (for
  example after Merge): escalate, or continue to the next step.
- How invariant 1 is enforced for `run:` steps, which can run any shell
  command in the worktree, since a save-time check cannot see what a command
  does.
- How the workflow marks which steps are "cleanup steps" for Close.
- How Pause and Resume (ADR-0027) map onto a step in progress.
- Whether a Ticket-level `vars:` override is set in the UI, by label, or both.

## Supersedes

ADR-0038's hardcoded resume table (the list under its "Accept → override the
failed Step" heading). ADR-0038's no-re-verify rule, candidate
requirement and Retry amendment (#817) stand.

Amends ADR-0020 (the work run after Accept and Retry comes from the workflow;
states and transitions unchanged), ADR-0028 (its verify lists no longer
govern Tickets and Native Tasks) and ADR-0037 (verifier overlays are replaced
by workflow steps; the overlay pattern is reused for Workflow Labels).
