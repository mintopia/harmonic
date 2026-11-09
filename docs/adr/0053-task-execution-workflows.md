# Decision: Task Execution Workflows define a Ticket's whole execution process

Status: accepted
Date: 2026-10-30

Amended by ADR-0057 (2026-10-31): Epics run on this engine through the bundled `epic` workflow; the Epic deferral below no longer applies.

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

1. **Only the agent commits** to the Ticket branch (ADR-0001). Before every
   `run:` and `command` step the engine records HEAD and the commit count; a
   new or amended commit, or a moved branch, fails the step as a guardrail
   trip (ADR-0002).
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
  `attempts: { max: ${{ vars.maxAttempts }}, steps: [...] }`. A `fail` or
  `inconclusive` outcome inside the block starts the next Attempt, as
  `inconclusive` burns an Attempt under ADR-0003; exhausting `max` escalates.
- **A `fail` outside the `attempts:` block escalates.**
- **A top-level `cleanup:` step list** runs when the Ticket reaches `done` and
  when it is Closed.
- **No `goto` and no unbounded loops.**
- **Pause keeps ADR-0027's semantics.** The in-flight turn finishes; Resume
  continues at the next step not yet run.

### Variables and secrets

- **Read-only context**: `ticket.*` (title, body, labels, ref), `attempt.*`
  (number, previous verdict, failure reason) and `workspace.*`.
- **`vars:`** declare defaults that a Workspace and a Ticket can override. A
  Ticket's values are set only in a Variables panel on the Ticket page, and
  only for vars the workflow declares.
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
- **Close** runs the workflow's `cleanup:` steps.

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
- **Bundled workflows are seeded on boot** (amended 2026-11-09; see the
  amendment below). They are editable operator workflows, not read-only
  library entries. **Duplicate** makes a copy of any workflow.
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
  A `run:` or `command` step that commits trips a guardrail rather than
  passing, so a workflow cannot route around the agent-commits invariant.
- An escalation outside the `attempts:` block (for example a failed step after
  Merge) gets the same three Escalation actions as any other.
- Every rename from `workflow` to Issue Workflow touches the schema, API types
  and UI.

## Supersedes

ADR-0038's hardcoded resume table (the list under its "Accept → override the
failed Step" heading). ADR-0038's no-re-verify rule, candidate
requirement and Retry amendment (#817) stand.

Amends ADR-0020 (the work run after Accept and Retry comes from the workflow;
states and transitions unchanged), ADR-0028 (its verify lists no longer
govern Tickets and Native Tasks) and ADR-0037 (verifier overlays are replaced
by workflow steps; the overlay pattern is reused for Workflow Labels).

## Amendment (2026-10-31): Steps reference Model Options by code

An `agent` or `critic` step can name a Model Option (ADR-0052) instead of a
Harness and Model, so a workflow reuses the operator's curated choices rather
than hard-coding model ids. Issue #944.

- **Model Options carry a code.** Each Model Option has a short, unique code
  (lowercase letters, digits and hyphens, e.g. `opus-deep`). The Route
  Classifier's `optionId` is this code.
- **`with: { option: <code> }`** on `agent` and `critic` steps. It is mutually
  exclusive with `harness` and `model`; a step that sets both is refused at
  save. A step with `option:` has explicit values, so it ignores routing like
  any other explicit step (§ Interaction with routing).
- **Resolution: Ticket, then Workspace, then global.** When the step runs, a
  code resolves against the Ticket's own Model Options, then the Workspace
  overlay, then the global list; the innermost definition wins. A Ticket sets
  its Model Options only in a panel on the Ticket page, and only for codes
  already in the Workspace overlay or the global list, as Ticket `vars:`
  overrides are limited to declared vars. A Ticket override changes that code's Harness and
  Model for that Ticket only. The Route Classifier picks from the same
  resolved list.
- **Refused at save, escalated at run.** Workflows are global, so the save
  check refuses a code defined nowhere: not in the global list and in no
  Workspace overlay. The editor reports it at its line and column, and Save is
  refused until it is fixed. A code that is missing or disabled in the Ticket's
  resolved list when the step runs escalates the step as a configuration
  failure. It never falls back to the route or to another option, consistent
  with invariant 5.
- **Editor and builder.** Completion offers the defined codes after `option:`,
  each with its Harness, Model and description. The block builder offers the
  same codes as a picker on agent and critic blocks.

This amends ADR-0052: a Model Option gains a code, a Ticket override joins the
global list and Workspace overlay, and a code may repeat across those three
lists, the inner definition shadowing the outer. Within one list a code is
unique.

## Amendment (2026-10-31): Bundled `implement` and `research` workflows

Two workflows ship in the package: `implement` and `research`. On an unedited
install they reproduce today's execution.

- **`research` has no `cleanup:`.** Cleanup deletes the Ticket branch, and that
  branch holds the research artifact.
- **`verify`** is a marker step that always passes. The Task-side verify
  command and critic lists were removed (ADR-0055), so a Ticket's checks are the
  explicit `run:`, `command` and `critic` steps in its workflow.
- **`post-merge-check`** runs its `run:` script in the detached base checkout
  after the merge. With no `run:` it passes.
- **Prompt Library codes.** The prompt on an `agent` or `critic` step may select
  a Prompt Library code with an expression. After the Library lookup, `{field}`
  placeholders are filled once. Field values are never expanded again.
- **`merge` always produces a merge commit.** `merge` and `artifact` pass for
  Tasks that work in place. A refused `close-ticket` marks the close pending and
  passes.
- **Accepted divergences from today's path:**
  - A rebase conflict escalates instead of going to the agent.
  - There are no `finish_task` continue nudges.
  - There is no peer or code-index prompt text.
  - The engine's post-merge check runs after the Merge is published.
  - Critic prompts are not byte-identical to the old critic prompt.

## Amendment (2026-10-31): a workflow classifier may choose the workflow

Issue #930. The Workflow Label is the only automatic input to a Ticket's
workflow choice in § Assignment. This amendment adds a second, AI-based
input, so a Ticket with no label can still reach the right workflow.

- **Precedence**: an operator's explicit choice on the Ticket, then the
  Workflow Label, then the workflow classifier, then the Workspace default,
  then the global default. The classifier is consulted only when neither the
  operator nor a Workflow Label has decided.
- **The Route Classifier does not choose workflows.** ADR-0052's Route
  Classifier still picks only Harness and Model. The clause "Not chosen by
  AI. The Route Classifier picks Harness and Model only." in § Assignment
  is replaced by the rule below.
- **A separate workflow classifier, off by default.** Each Workspace turns it
  on or off with its own field, `workflowClassifierEnabled`. It chooses one
  workflow from the global library by name and description.
- **Shared backend and settings.** The backend (TypeSafe, OpenAI-compatible
  or configured Harness), timeout, Harness and Model, endpoint and Secrets are
  the same settings ADR-0052 defines for the Route Classifier. Only the
  on/off switch is separate.
- **When it runs.** When the Ticket starts working and on Retry, the same
  moments the Workflow Label resolves. It never runs per Attempt. An in-flight
  Ticket never switches workflow.
- **Not classified.** A Ticket with a wayfinder research type, an operator
  choice, or a matching Workflow Label is not classified.
- **Abstain, visibly.** On an error, a timeout, invalid output, or an id not in
  the library, the classifier abstains and the Workspace default applies. A
  Task event in Activity records the reason.
- **Shown on the Ticket.** The Ticket page shows the workflow as "chosen by
  classifier" with the one-line reason.
- **Cost is a routing line.** Its Usage and Cost are recorded on the Ticket as
  a routing cost line, in columns `workflow_routing_usage` and
  `workflow_routing_cost`. They are kept apart from implementation Cost.
- **Not a Step.** The classification adds no Step type and no Step, as with
  the Route Classifier (ADR-0052).

## Amendment (2026-11-09): Bundled workflows are seeded, not read-only

This replaces the clause "Bundled workflows ship in the package, read-only, and
are upgraded with Harmonic. Duplicate makes an editable copy."

- **On boot, each packaged definition (`implement`, `research`, `epic`) whose
  name has no operator workflow file is written as an operator workflow at
  version 1.** Seeding is idempotent: an existing operator file of that name is
  never overwritten, and a second boot changes nothing.
- **Bundled definitions no longer appear in the library.** The Workflows API
  and settings page list only operator workflows; there is no `bundled` flag and
  no read-only mode. The seeded copies are edited, assigned, and
  delete-protected like any other workflow.
- **Packaged definitions stay in the package as templates** that boot seeds
  from. They are not upgraded in place: an operator's edited copy is theirs.
