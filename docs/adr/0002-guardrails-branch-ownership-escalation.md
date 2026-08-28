# Decision: Guardrails, branch ownership, and the escalation surface

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

## Guardrails are runtime limits that trip to Escalation

Harmonic watches a running Attempt and, when a **Guardrail** trips, stops it
and **escalates** the Task with a short reason on the card — never a new
terminal state, never an auto-complete. An execution otherwise ends only three
ways: the agent signals, the process dies, or the operator acts; the Guardrail
is the runtime's own backstop for the hang-but-alive, the within-turn spin,
and the time/cost runaway that turn-count bounds never see.

Members:

- **Budget** — elapsed wall-clock, tokens, or cost. The cost dimension falls
  back to the token budget when a model has no configured price (Cost is
  unpriceable there); it never silently no-ops, and wall-clock always guards.
- **Progress** — a stall/loop detector, on/off only; its thresholds are
  internal. It nudges once through the steer channel (which never spends the
  continue budget, ADR-0005) before escalating.
- **Branch-contract** — see below; same trip→escalate outcome, same card slot.

Guardrails resolve as a global default with a per-Workspace override
(per-Task deferred until a Task demonstrably needs one) and are invisible
until one trips. An auto-failing or auto-completing trip was rejected: work
near a budget may be valuable or worthless, and a human decides which.

## Harmonic owns branching; enforced by detection, not prevention

The agent never creates or switches branches — Harmonic owns branch and
worktree management. Prevention is unreliable for an unattended execution
(permission gating cannot see a `git checkout -b`; repo hooks are invasive),
so the contract is enforced by detection:

1. Record the branch the Attempt started on, in both isolation modes.
2. At settle, verify HEAD is still on that branch and no stray branch holds
   the work — judged from **the agent's own working directory**, never
   inferred from ref movement elsewhere (ADR-0001's forensic-guard ban).
3. On a violation, re-invoke the agent (same Session, one corrective turn to
   merge its work back onto the intended branch), then escalate if still
   violated.

A Drive Prompt line telling the agent Harmonic owns branching is kept as
belt-and-braces, never relied on.

## One escalation surface, three actions

A Task reaches `escalated` only via: (1) attempt counter exhausted, (2) a
guardrail trip (branch-contract included), (3) permanent infrastructure
failure, (4) an unresolved merge conflict after the bounded resolve turns, or
(5) a red post-merge check — its revert recorded on the timeline (ADR-0001).

Exactly three actions there:

- **Reject with guidance** — guidance becomes feedback, the counter resets,
  and the Task **requeues** to `ready`.
- **Accept** — counts as success; the normal success path (merge, close,
  cleanup) continues.
- **Close/Cancel** — closes the Task and runs cleanup (remove branch and
  worktree, close the tracker issue).

## Reject requeues; it never force-starts

Reject with guidance records the guidance, resets the attempt budget, and
returns the Task to `ready`. It does **not** start the next Attempt: from
`ready`, capacity picks it up (the Auto-Runner, under the Machine Ceiling and
Workspace cap), or a human starts it manually. Bulk-rejecting a backlog is
therefore safe — N rejects leave N Tasks `ready` and the scheduler drains
them within configured concurrency, not a stampede of N simultaneous starts.

**The warm-Session exception (the one override, and why).** When the Task has
a live, still-warm Session to reuse — warm *and healthy*, meaning its context
usage is under the reuse threshold — the reject surface offers an explicit
**"start now"** (`reject { start: true }` on `POST /tasks/:id/reject`; the
warm-Session affordance is its only caller). Chosen, it starts the
continuation immediately, bypassing the capacity ceiling the same way a
manual start does. Rationale: a warm resume is near-free and skips reloading
context into a cold session, so for a one-line piece of feedback it is both
cheaper and far quicker — perishable Session warmth should not be lost
waiting in the queue. A cold or absent Session offers no such option.

Where ADR-0001's summary ("requeues are rejected, never force-started")
meets this exception, this ADR's wording takes precedence.

## Consequences

- New settings: guardrail defaults global with per-Workspace override.
- The escalation surface replaces every earlier escape hatch (adopt-and-
  review, note-to-critic, un-escalate, `reattempt`) — one surface, three
  actions.
- The continuation preview endpoint (`GET /tasks/:id/continuation`) drives
  the "start now" affordance.
- The corrective-turn cap for a branch-contract violation is 1, then
  escalate.

## Absorbed at the reset

Pre-reset 0019 (trip→escalate; v5 reconciliation dropped), 0023 (contract,
detect-at-settle, branch-contract guardrail; v5 reconciliation and the
clean-lease amendment dropped with the old integration path), 0041's
escalation surface, 0048 in full. See README.md for the mapping.
