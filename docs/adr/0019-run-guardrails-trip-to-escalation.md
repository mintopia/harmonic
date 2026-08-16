# Run Guardrails are runtime limits that trip to Escalation

Harmonic watches a *running* Run and, when a **Guardrail** trips, **stops the
Run and Escalates** it (afk→hitl, flagged, a short reason on the card) — never a
new terminal state, never an auto-complete. v1 members are a **budget** Guardrail
(elapsed wall-clock, tokens, or cost) and a **progress** Guardrail (a stall/loop
detector). Guardrails resolve as a global default with a per-Workspace override
(per-Task deferred) and are invisible until one trips.

We chose this because a Run today ends only three ways — the agent signals
(`finish_task`/`escalate_task`), the process dies, or the operator acts. An afk
Run that hangs-but-alive, spins within a turn, or runs away on time/cost has no
backstop: the only existing bound is the turn-count `continueAttempts`, which
bites only when the agent *ends* a turn, and Usage is metered live but never
enforced.

## Considered options

- **No backstop / rely on `continueAttempts` and `autoRetry` (rejected).** Both
  are turn-count bounds; they never see within-turn spinning, an idle-but-alive
  process, or unbounded wall-clock/cost.
- **Trip auto-fails or auto-completes the Run (rejected).** A Run near its budget
  may hold valuable *or* worthless work — failing discards it, completing merges
  junk. Neither is an honest outcome.
- **Trip stops the Run and Escalates with a reason (chosen).** Reuses the
  existing afk→hitl handoff and card treatment; never strands or misjudges work;
  a human decides what the half-done state is worth.

## Consequences

- The **budget** Guardrail's cost dimension falls back to the **token** budget
  when a model has no configured price (Cost is unpriceable there — see ADR-0010
  and CONTEXT *Cost*); it never silently no-ops, and wall-clock always guards.
- The **progress** Guardrail is on/off only; its loop-pattern thresholds are
  internal. It nudges once through the steer channel (which does not spend the
  continue budget — ADR-0018) before Escalating.
- The **branch-contract** check (ADR-0023) is modeled as a Guardrail — same
  trip→Escalate outcome, same card slot.
- New global + per-Workspace settings; per-Task override deferred until a Task
  demonstrably needs one.

## Reconciliation with the v5 design (post-Codex review)

The core decision holds (a Guardrail trip → Escalation). The 5-round adversarial
review added: a trip is an append-only `run_fact` and the **coordinator** computes
terminal disposition by fixed precedence (not a direct settle or first-writer CAS);
a persisted **Execution Chain** carries cumulative budget across
retry/reject/resume/self-heal so a retry cannot reset-and-bypass the ceiling;
budgets are **phase-scoped** (execution vs review-SLA vs landing-timeout), and an
unmeasurable configured guard **trips to Escalation** rather than silently
degrading. See `docs/reliability-design.md` §0 and Unit A.
