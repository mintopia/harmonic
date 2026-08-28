# Decision: Run and Attempt coexist — amend ADR-0041's deletions, unify only the double-booked counter

Status: accepted
Date: 2026-08-28

## Context

ADR-0041 (unified ticket lifecycle) declared four things deleted — **Run**, the
**phase machine**, the **candidate snapshot machinery**, and **self-heal** — and
redefined the loop around an **Attempt** ledger, stating "Run and Phase are
deleted." That deletion never happened, and the codebase has since moved the
other way:

- **`runs` is heavily load-bearing.** The table (`src/db/schema.ts:293-377`)
  still carries `attempt`, `phase`, `candidateOid`/`candidateRef`, and
  `diffBaseOid`/`diffHeadOid`. `run.` is referenced across 36 files (169 times in
  `src/execution/runner.ts`). Columns were *added* to it on and after ADR-0041's
  own date — `drizzle/0053_run_diff_revisions.sql` (2026-08-25).
- **The phase machine still routes execution.** `RUN_PHASES`
  (`src/domain/run-phases.ts:13`) drives crash-recovery orphan detection
  (`src/domain/runs.ts:343,392`) and guardrail scoping
  (`src/execution/runner.ts:2527+`). A comment at `runner.ts:2213-2215` claims a
  transition "never writes or consults `runs.phase`" — flatly contradicted by
  `merge-coordinator.ts:164,202` and `runs.ts:343,392` in the same tree.
- **Candidate machinery is re-affirmed by a *newer* accepted ADR.** ADR-0046
  (2026-08-27, two days after 0041) explicitly keeps the candidate
  freeze → rebase → verify sequence for worktree isolation. ADR-0042
  (2026-08-26) builds the lifecycle timeline on phase / verification / candidate
  facts. Deleting candidate machinery would contradict two later accepted
  decisions.
- **Self-heal is a live turn purpose.** `'self-heal'` is a first-class member of
  `TURN_PURPOSES` (`src/domain/turn-queue.ts:21`) gating turn-queue admission,
  git ref handling (`git.ts:257,382`), crash recovery
  (`crash-recovery.ts:34,241`), and the UI
  (`web/src/components/VerificationCard.tsx:114`).
- **The Attempt ledger exists but is a satellite, not a replacement.** The
  `attempts` table is real (`drizzle/0049_attempt_task_timeline.sql`,
  `src/domain/attempts.ts`), but `attempts.number` has no independent increment:
  every one of ~15 call sites in `runner.ts` writes `runs.attempt` and passes the
  same in-memory value to `attempts.ensureForRun(...)`. No FK or trigger ties
  them; `attempts.number == runs.attempt` is maintained by hand.

So the drift is real, but ADR-0041's diagnosis was wrong: Run / phase / candidate
/ self-heal are not vestigial dead code to be deleted — they are load-bearing,
and the two ADRs written *after* 0041 depend on them. The one genuine defect is
the **double-booked attempt counter**, plus the resulting glossary and comment
drift.

The choice this ADR records: **actually delete and unify onto the Attempt
ledger, or amend ADR-0041 to admit coexistence.**

## Decision

**Amend ADR-0041 to admit coexistence.** Run and Attempt are complementary, not
redundant, and neither is deleted:

- **Run** stays the execution unit — one harness process / prompt turn, carrying
  the Session, Usage, guardrails, the `phase` machine, the candidate ref,
  crash-recovery routing, and the `run-<n>` branch suffix. `RUN_PHASES`, the
  candidate machinery, and the `self-heal` turn purpose all remain.
- **Attempt** stays the loop-iteration ledger — one implement→verify iteration,
  the history unit and the attempt counter on the Ticket page.

ADR-0041's line "**Run and Phase are deleted**" is corrected: they coexist. This
brings the written record in line with ADR-0042 and ADR-0046, which already build
on this machinery.

**Unify the one thing that is genuinely double-booked: the attempt counter.**
Make the **Attempt row the single source of truth** for the counter and have
`runs` reference it, so the DB — not 15 hand-synced call sites — enforces the
invariant:

- Replace the bare `runs.attempt` integer with `runs.attemptId` (FK →
  `attempts.id`).
- `attempts.number` becomes authoritative (one row per Ticket attempt, allocated
  once). Backfill from the mapping migration 0049 already establishes
  (`attempts.task_id = runs.task_id AND attempts.number = runs.attempt`).
- Crash recovery and the ~15 `runner.ts` sites read the counter through the
  Attempt row / FK.

(Lighter fallback, if re-pointing crash recovery proves costly: keep
`runs.attempt` authoritative and make `attempts.number` a derived projection
rather than stored redundant state. Either way there is exactly one writable
counter.)

**No wholesale delete-batches follow.** Because coexistence is amended in, there
is nothing to rip out — the follow-up is a small reconciliation set (below), not
a Run / phase / candidate / self-heal teardown.

## Consequences

- ADR-0041 stays accepted; its lifecycle, states, escalation surface, and
  freshness gate are untouched. Only its four deletion claims are corrected —
  recorded as an "Amended by 0047" note on that ADR.
- CONTEXT.md is reconciled: "Run" stops being labelled a *deleted concept*; Run
  and Attempt are defined as coexisting with distinct roles; Phase, Candidate,
  and Self-heal get real entries; the counter's single source of truth is named
  (done in this ticket).
- The hand-synced counter becomes a DB-enforced FK — the "the two books drifted"
  bug class is designed out rather than watched.
- Risk accepted: keeping Run / phase / candidate / self-heal means the model
  stays larger than 0041 imagined. That is the honest cost of two later ADRs
  having built on them; a future ADR may still narrow the surface, but not by
  pretending it is already gone.

### Follow-up work (itemized)

1. **Single-counter collapse (code).** Add `runs.attemptId` FK, make `attempts`
   the authoritative counter, backfill via the 0049 mapping, re-point the ~15
   `runner.ts` sites and crash recovery, drop `runs.attempt`. Tests:
   crash-recovery attempt resolution, escalation-reset base
   (`AttemptStore.budgetBase`).
2. **Comment / claim reconciliation (code, docs).** Correct the false
   `runner.ts:2213-2215` comment; sweep stray doc-comments that reference deleted
   machinery (e.g. the `execution/candidate.ts` phantom at `schema.ts:899-928`).
3. **ADR cross-references (docs).** Note in ADR-0042 and ADR-0046 that the
   phase / candidate machinery they use coexists *by decision* (this ADR), not as
   unpaid debt.

No new tables, and no deletion of Run, phase, candidate, or self-heal.

## Supersedes

None. **Amends ADR-0041** — corrects its Run / Phase / candidate / self-heal
deletion claims to coexistence; the rest of ADR-0041 stands. Consistent with
ADR-0042 and ADR-0046, which already depend on the retained machinery.
