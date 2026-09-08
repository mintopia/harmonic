# Decision: Epic-as-workable and staged Verification

Status: accepted
Date: 2026-09-08
Implementation pending (epic to follow). Supersedes the single-critic model and
the whole-Epic verify clauses of ADR-0003; builds on the verify-in-place change
of 2026-09-08 (ADR-0003 amendment). Reworks the Verification surface of the
epic ADRs (0016/0018) without changing epic containment or first-class storage.

## Verification is a pipeline of stages, not one gate

Verification is no longer a single per-Attempt gate. It runs at **three
configured stages**, each an independent pair of verifier lists:

- **`verify.task.preMerge`** — in the Task's worktree, before the merge to the
  Epic.
- **`verify.task.postMerge`** — after the Task merges into `epic/<ref>`.
- **`verify.epic.preMerge`** — the **Epic Pre-Merge Verification**, once every
  Task is complete, before the Epic merges to the default branch.

Each stage carries `{ commands[], critics[] }`. **Commands** run ordered and
fail-fast; **critics** run in parallel and all-must-pass, and every critic's
feedback is collected before the retry (not first-failure). **Commands gate
critics** at every stage: no critic runs until all commands pass — no paying a
reviewer to read a tree that fails its own tests. A stage with zero verifiers
passes.

## Task critics carry a prompt pair; epic critics carry one

A **critic** becomes a first-class, listable verifier (`{ prompt, model,
harness }`), replacing the single `verify.review`. A **task critic** carries a
prompt **pair** — an `issuePrompt` and a `noIssuePrompt` — selected at run time
by whether the Task has a tracker issue (`trackerRef`): the issue variant
interpolates the full `{ref}/{title}/{body}/{url}` set, the no-issue variant
only the ticket-free tokens, so a bare-prompt Task is never reviewed against an
empty `{title}`. An **Epic is always a tracker container**, so an **epic
critic** carries a single prompt — the no-issue variant can never fire. Both
bodies are editable with a live compiled-prompt preview per variant.

## Failure paths, per stage

- **Task pre-merge fail** — a failed Attempt: feedback into the next Attempt,
  counter +1; `maxAttempts` → escalate the Task (ADR-0002).
- **Task post-merge fail** — the merge is already on `epic/<ref>`, so a failure
  is **revert-on-red**: revert that Task's merge commit off the integration
  branch and escalate the Task. Tasks merge one-at-a-time under the mutex and
  the check runs immediately, so the failed merge is still the tip and the
  revert is clean (ADR-0001).
- **Epic Pre-Merge Verification fail** — a **resolve loop** (below).
- **Epic → default-branch merge fail** — escalate the Epic, as the one merge
  policy already does (ADR-0001).

## The Epic is workable: it runs Attempts

The Epic Pre-Merge Verification and its resolve loop run as **first-class Epic
Attempts** — the Attempt attaches to an Epic, not only a Task. The Epic's
Attempt lifecycle is **inverted** from a Task's: it **verifies first**, and an
agent **executes only on failure**. A clean first pass is Attempt 1 = verify
passed, no agent spawned.

On failure, a **resolve agent** runs in the epic worktree on `epic/<ref>`,
driven by a **dedicated, editable `verify.epic.resolvePrompt`** (the Epic's
`{ref}/{title}/{body}/{url}` plus an injected failing-verifier feedback block),
commits its fix to the integration branch, and the **full** Epic Pre-Merge
Verification suite re-runs. This is bounded by the **normal per-Attempt limit**
(`maxAttempts`); exhausting it escalates the Epic, which reuses the exact Task
escalation and resume surfaces — no epic-specific escape hatch.

## Verification runs in place; one detached check remains

Every verifier runs **in place** in the live worktree that already sits at the
target commit — the Task's builder worktree for task stages, the Epic's
worktree for the Epic Pre-Merge Verification, and the epic worktree is also
where Tasks merge in and where the task post-merge check runs. The **only
detached checkout left in the system** is the epic→default-branch **post-merge
check**, which runs against the shared base where no worktree exists. This
retires the disposable per-Attempt detached worktree entirely (the interim
`runCommandVerifierDetached` epic carve of the 2026-09-08 amendment collapses to
this single case).

Rationale: one worktree, one agent — there is no concurrent reader to isolate a
mutating command from, and "verify exactly the committed tip" is vacuous when
nothing else mutates the tree. A disposable checkout only hides mutation
(anti-observability, ADR-0010) and silently omits anything not committed to the
base repo — sibling checkouts a task set up under the worktree included.

## Configuration

The flat `verify.commands` + single `verify.review` become nested per-stage
lists: `verify.task.{preMerge,postMerge}` and `verify.epic.preMerge`, each
`{ commands[], critics[] }`, plus `verify.epic.resolvePrompt`. Override grain is
**per-stage, per-list**: `null` inherits the global list, an array replaces it
whole, `[]` runs none. The old single-critic keys — `verify.review.*` and the
`WorkspaceRow` `reviewEnabled`/`reviewPrompt`/`reviewModel`/`reviewHarness`
columns — are **deleted outright**, no back-compat: a baseline edit and a DB
recreate, never a migration (ADR-0007 schema-sync doctrine).

## Consequences

- Attempts attach to Epics as well as Tasks; crash recovery, escalation, resume,
  Usage/Cost rollup, and the Attempt timeline all extend to Epic Attempts.
- The verifier-status surface (ADR-0003) multiplies to per-stage, per-verifier;
  its rendering is a UI follow-up, out of scope here.
- Whole-Epic Verification's "runs no corrective turn at Epic scope" clause is
  reversed: the Epic now runs a bounded resolve loop.
- The settings surface must edit lists of commands and critics at three stages,
  and prompt pairs with dual preview — a real UX build, tracked separately.
- Single-critic vocabulary (`review`, Review Step) is renamed out; a Verification
  Step exists per command and per critic.

## Supersedes

ADR-0003's single-critic Review model and its whole-Epic-verify-without-resolve
clause; the `verify.review` config shape. ADR-0003's in-place doctrine and the
verdict-attaches-to-Attempt rule (ADR-0001) stand and extend to every stage.
