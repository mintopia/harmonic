# Decision: Operator Accept auto-rebases onto an advanced base without re-verifying

Status: accepted
Date: 2026-08-26

## Context

ADR-0041's landing freshness gate refuses to fast-forward a base branch to a
verified candidate unless the base's current tip is still contained in that
candidate — "verification saw exactly the landed tree." When the base advanced
since verification, the auto-driven Runner re-enters Rebase → Verification on the
same Attempt (`freshenForLanding`), rebasing onto the new base tip and re-running
the full verifier suite before it re-checks.

Operator **Accept** on an escalated ticket does not go through that loop. It
applies the `target-ref` landing effect directly (`EscalationService.accept` →
`landingEffectsFor` → `landBranch`), fast-forward-only, with no freshen step. So
when the base has moved, Accept dead-ends with
`base '<b>' advanced after verification; rebase and re-verify before landing`
and the operator has **no affordance to recover** — no re-verify button, no
rebase action. In practice this fires constantly: a manual Accept has a human
delay baked in (the operator is reviewing), during which the base very often
advances — frequently for reasons entirely unrelated to the candidate (an
unrelated merge, a docs commit). Forcing a full re-verification cycle — which
includes a fresh critic agent turn (tokens + minutes) — for what is usually an
unrelated advance is the wrong trade for a human-initiated action.

## Decision

When an operator clicks Accept and the base has advanced past the verified
candidate, **auto-rebase the candidate onto the current base tip and land the
result, without re-verifying.** Only a genuine rebase *conflict* falls back to
the manual/escalation path.

Mechanically: the `landBranch` primitive gains an opt-in `rebaseOnAdvance` flag
(fast-forward mode only). On the stale-base branch, instead of refusing, it
replays the verified candidate onto the advanced base tip in a throwaway
detached admin worktree (`Git.rebaseOnto`) — the live candidate branch and base
checkout are never touched, exactly as the `'merge'` land already works — and
lands the replayed tip through the same expected-old-OID CAS. A rebase conflict
returns `{ ok:false, reason:'conflict' }`; a clean rebase lands and the outcome
carries `rebased: true` so the disposition is observable in the journal. Operator
Accept (`landingEffectsFor`) sets `rebaseOnAdvance: true`; the auto-driven path
does **not** — it keeps freshening and re-verifying through the Runner's loop,
because no human is in that loop to vouch for the result.

## Consequences

- Operator Accept "just works" through the common base-advance case instead of
  dead-ending; the human's review is trusted, and only a real textual conflict
  requires manual intervention.
- **Re-verification is deliberately skipped on manual Accept.** A base change
  that touches the same code the candidate touches could land a semantically
  broken result with no textual conflict — this is exactly what the auto path
  re-verifies to catch. The trade is accepted for a human-initiated Accept; the
  operator is the reviewer. A future refinement could re-verify only when the
  base change overlaps the candidate's files (the "overlap guard"), keeping the
  silent-rebase fast path for the non-overlapping common case.
- The rebased tip is a new tree (base + candidate replayed), so what lands is not
  byte-identical to the verified tree; the candidate's own changes are preserved
  by the replay, the base's changes are trusted.
- No schema change; `landBranch` stays a pure, CAS-guarded git primitive and the
  rebase happens off to the side in a disposable worktree, so its crash-idempotent
  and desync-safety properties are unchanged.

## Supersedes

None. Refines the landing freshness gate of ADR-0041 for the operator-Accept
disposition (ADR-0027 escape hatches).
