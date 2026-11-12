# Decision: Attempt surfaces are built from workflow step runs; the legacy Step model is removed

Status: accepted
Date: 2026-11-12

## Context

ADR-0053 moved execution onto Task Execution Workflows, which record every
executed step in `workflow_step_runs`. The older fixed-pipeline record, the
Attempt `steps` table (Rebase, Implementation, Verification, Critic), kept
being read by the Ticket page, the Board, the API and the archive, so those
surfaces described a pipeline that no longer runs: verification read as
disabled, critic cost and transcripts were dropped, `merge_status` was never
written, and a crash left step runs open. "Attempt" also meant two things: a
row in `attempts`, and an iteration of the workflow's `attempts:` block
(ADR-0057 calls the latter a step-run attempt). The page then showed "Attempt
N" twice, with different meanings.

## Decision

**Vocabulary, as in GitHub Actions.**

- An **Attempt** is one run of the Ticket's workflow. A start or a Retry
  creates it. Accept and Resume continue the same Attempt row.
- A **Pass** is one iteration of the workflow's `attempts:` block inside an
  Attempt. It is stored as `workflow_step_runs.attempt` and surfaced as `pass`.
- A **Step run** is one execution of one workflow step.

**`workflow_step_runs` is the only step record.** It gains nullable
`attempt_id`, `session_row_id`, `harness`, `model` and `usage` columns and an
`(attempt_id, id)` index. Agent and critic step runs link their Session, so a
step run's transcript is that Session over the step run's time range. The
legacy `steps` table and its rows are dropped, with no conversion. Pre-change
Attempts show no step runs. `verification_attempts` is removed later, once
Stats and history no longer read it.

**The Attempt view is the single step and progress view.** A selected Attempt
shows a header (Attempt N, state, a cost, duration and model summary row), a
Pass selector when the `attempts:` block ran more than one Pass, then the
Attempt's step runs as an ordered list of expandable rows: status icon, step
id, kind, one-line summary, duration. A row expands inline to content by kind:
agent, the live or recorded transcript, with the steer box while running;
check, the command output log; critic, verdict, reason, findings and the
critic transcript; rebase, publish and tracker, summary, URL or branch.
Default expanded: the running step, else the failed step, else the last agent
step. Steps not yet run in the current Pass show as pending rows from the
workflow outline. A Ticket with no Attempt yet shows the outline as pending
rows. The separate page-level Workflow Steps section and the Task progress bar
(`TaskProgressBar`, `taskLifecycle`) are both removed.

**API.** An Attempt serves its step runs, ordered by id, each with step id,
action, `kind`, `pass`, outcome (null while running), summary, detail,
outputs, Session link, harness, model and cost. `kind` is one shared pure
mapping of the action: `rebase` to rebase; `agent` to agent; `run`, `command`
and `post-merge-check` to check; `verify` to marker; `critic` to critic;
`merge`, `open-pr` and `artifact` to publish; `close-ticket` and `comment` to
tracker; `cleanup` to cleanup. Step-run log, prompt and output are fetched per
step run.

**Derived state.** A Task's `currentStep` is its running step run (latest of
the running Attempt with no outcome). Merge status is derived from the running
step's action (`merge` reads as merging); the stored column is dropped.

**Crash recovery.** At boot, in the same pass that marks interrupted Attempts,
step runs with no outcome get an end time and the summary `interrupted by
process death`, but keep a null outcome so crash resume re-runs the step in
the same Pass instead of counting it as a failed one. A step run is running
only while it has neither an outcome nor an end time.

**Archive layout.** Per-step-run directories replace the per-Step ones:
`attempts/<n>/steps/<pass|_>-<stepId>-<stepRunId>/`, holding that step run's
session stream, resolved prompt and the full uncapped output of a `run:`
command.

## Replaces

- **ADR-0011**: the Ticket page clauses that fold "Attempt/Step transitions"
  and "skipped/disabled" verification into the timeline, and that draw
  progress "using actual Attempt/Step results". Timeline and progress now come
  from step runs, with the Attempt view above. The API and design-world
  clauses stand.
- **ADR-0003**: per-verifier status and "always visible" verification are
  realised as check and critic step runs, not a fixed verification block. The
  critic transcript is the critic step run's Session. The verdict-attaches-to-
  Attempt and `inconclusive` backstop clauses stand.
- **ADR-0044**: the archive layout. Streams are teed per step run, not per
  fixed Step; "every verify command's full output" is kept per `run:` step
  run. Everything else in ADR-0044 stands.
- **ADR-0038 and ADR-0002**: only Step-shaped wording ("failed Step",
  "advances to the next Step"). Accept, Reject and Close behave as before, over
  the workflow's step runs (ADR-0053).
- **ADR-0057**: "step-run attempt" is renamed Pass. Epic Attempts keep one
  Attempt per run; the Epic page uses the same Attempt view.

## Consequences

- Operators see what actually ran, per step, with its own transcript, cost and
  output. A step that failed is the expanded row.
- The workflow outline appears only as the pending part of the Attempt view.
- Old Attempts lose their step rows after upgrade (ADR-0042 snapshots cover
  rollback).
- "Attempt N" and "Pass k of max" no longer collide.

## Supersedes

None. It amends ADR-0011, ADR-0003, ADR-0044, ADR-0038, ADR-0002 and ADR-0057
as listed.
