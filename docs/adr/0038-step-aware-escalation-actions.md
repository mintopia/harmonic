# Decision: Step-aware escalation actions — Reject spawns a fresh Attempt, Accept advances the pipeline

Status: accepted
Date: 2026-09-22

## Context

An Attempt runs a fixed Step pipeline: `rebase → implementation → verification
→ review` (`STEP_TYPES`, `src/db/schema.ts`; `review` is the critic). A step
failure that exhausts the retry budget escalates the Task, exposing the three
operator actions of ADR-0002 (Reject / Accept / Close).

Two things drifted from what the operator wants:

- **Reject reuses the escalated Attempt in place.** Issue #506 ("unified
  manual resume") folded reject into the manual-resume path, which flips the
  *same* Attempt row back to `running` (counter unchanged). After a
  critic-failed escalation this renders a mixed-phase timeline — the prior
  run's `verification`/`review` steps sit `passed`/`failed` next to a fresh
  `implementation In Progress` on one Attempt — and never advances the visible
  Attempt number, contradicting the self-heal path, which *does* create a new
  Attempt per retry.
- **Accept is all-or-nothing.** ADR-0002 defined Accept as "re-verify the
  candidate, then merge" (with Force-Accept as the as-is escape); the shipped
  code simplified this to an as-is merge. Neither lets the operator say "this
  one failed step is fine — carry on" when the failure was at an intermediate
  step and the remaining pipeline is still worth running.

## Decision

The escalation surface keeps its three actions. Reject and Accept are
redefined; Close is unchanged.

### Reject → a fresh Attempt that reuses the warm Session

Reject-with-guidance creates a **new Attempt** (the Attempt number increments,
e.g. 2 → 3), resets the retry budget, and folds the guidance into the next
implementation prompt. It **reuses the prior agent Session when warm and
healthy** and otherwise takes the normal cold path — Session binding is
Task-scoped (`resolveContinuationSource` walks the Task's Attempts newest-first
for the latest live Session), so a brand-new Attempt inherits the warm Session
through the same `bindContinuationIfEligible` code self-heal retries use; a cold
or over-threshold Session is offered as a new/condensed session through the
continuation preview, never silently reused.

Capacity behaviour is unchanged from ADR-0002: Reject requeues to `ready` and
waits for the scheduler, except the warm-Session **"start now"**
(`reject { start: true }`) override, which starts the continuation immediately.

This supersedes #506's same-Attempt reuse *for the reject path only*; pause
resume and self-heal retries are untouched.

### Accept → override the failed Step and advance the pipeline

Accept means "the operator judges the failed Step acceptable." It marks that
Step `passed` (an operator override, distinct from a verifier pass) on the
**same Attempt** and resumes at the **next** Step:

- Failed at `rebase` → run `implementation`.
- Failed at `implementation` → run `verification`.
- Failed at `verification` → run `review`.
- Failed at `review` (the final Step) → **Accept and Merge**: merge the
  candidate through the one merge policy (ADR-0001) and run the success path
  (merge, close, cleanup). This is the whole of the old as-is Accept.

Accept does **not** re-verify (the operator's Accept *is* the judgement for the
overridden Step) — ADR-0002's "Accept re-verifies, else Force-Accept" design is
withdrawn. A candidate commit (a work product) is required for Accept in every
case, not only at the merge: Accept never advances or merges an empty ticket,
and by the time verification or review can fail the Attempt has produced a
candidate. This keeps the existing "no verified branch head → 409" contract.

If the advanced-to Step later fails, it escalates again as normal, and the
operator gets the same three actions at that Step.

## Consequences

- A new execution entry point runs a single pipeline stage
  (`verification`/`review`) without a fresh implementation turn — today
  `runVerification` is reachable only after a full implementation turn
  completes. The schema's unused `'skipped'`/override step-state machinery
  (`STEP_STATES`, `src/db/schema.ts`) backs the operator override.
- The Attempt timeline shows a rejected Attempt as a new Attempt N+1, and an
  accepted-advance as the overridden Step passing followed by the next Step
  running — no more mixed-phase single-Attempt display.
- Bulk reject stays safe: N rejects leave N Tasks `ready` (ADR-0002), now each
  with a fresh Attempt rather than a reused row.

## Supersedes

Amends the escalation-surface section of ADR-0002 (Accept semantics; the
Reject-in-place reuse introduced after it by #506). Leaves ADR-0001's merge
policy (Accept-at-`review` still uses it), ADR-0003's verifier/critic
definitions, and ADR-0005's Session/steering model intact.
