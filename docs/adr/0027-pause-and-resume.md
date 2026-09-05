# Decision: Pause and resume — an operator execution freeze and one unified warm/cold resume

Status: accepted
Date: 2026-09-05
Extends ADR-0001 (execution model, lifecycle states) and ADR-0002 (escalation
surface). Builds on the Session continuation machinery of ADR-0005.

## Context

Harmonic can start, steer, and escalate Attempts, but an operator has no way to
say "stop what you're doing, I'll come back to it" — the only ways to halt work
are Cancel (terminal, throws the record away) or waiting for an escalation. Two
needs are unmet:

1. **Pause.** An operator wants to freeze a running Task, or the whole fleet,
   without losing the Attempt, the worktree, or the warm Session — for example to
   run a manual task in the same checkout, or to stop the fleet burning tokens
   while they investigate something.

2. **Resume.** Harmonic already computes everything a good resume needs — the
   warm/cold band, the deterministic continue-full-vs-condensed recommendation,
   and the Cost estimate for each path (`src/domain/session-continuation.ts`) —
   but that machinery is wired to exactly one trigger (`human-reject`), and
   `steerSettled` *hard-refuses* a resume once the Session has gone cold. The
   operator sees the warm/cold choice only on an escalation rejection, and can
   never continue a cold Session at all, even though continuing it is always
   valid (ADR-0001: reuse is a cost signal, not a correctness gate).

The prompt cache these estimates track is the **provider's**, and it decays on
wall-clock. Harmonic only estimates its warm-until from `lastActiveAt +
cacheWarmSeconds`; it cannot stop it going cold.

## Decision

### Pause is a new lifecycle state

Add **`paused`** to the stored Task states (ADR-0001): `draft → ready → working
→ done`, plus `escalated`, `cancelled`, and now `paused`. Only a **`working`**
Task can be paused. `paused` is an operator freeze — distinct from `escalated`
(the agent gave up) and from a Blocker (a dependency). Its cause is recorded as a
Fact on the timeline; entering and leaving it are lifecycle transitions.

Ready/queued Tasks are **not** pausable: whether unstarted work runs is the
Auto-Runner's job (the master switch and agent-workability), not a second
overlapping mechanism.

### Pause is graceful

Pausing injects a **canned pause steer** over the existing steer channel
(`Runner.steer`) — "finish the current action and stop; start no new work" — then
waits for the in-flight turn/activity to settle before moving the Task to
`paused`. No mid-tool abort: the Session stays intact and the partial work is
preserved. If the Attempt is idle/between turns, it freezes at the boundary
immediately. The steer text is a Setting Override (Baseline → Global →
Workspace), defaulting to the canned message.

### Global Pause is a latched execution freeze, orthogonal to the master switch

**Global Pause** is a fleet-wide, **latched** freeze: while it is on, every
running Attempt is paused, and any Attempt that *starts* (picked up or manually
launched) enters `paused` immediately, until the operator globally resumes.

It is **orthogonal** to the Auto-Runner **master switch**. The master switch is
the *automation gate* — whether new work is **picked up**. Global Pause gates
whether any Attempt **executes**. The two are independent by decision: an
operator may switch automation off while leaving running Tasks alone (to run a
manual task), or freeze everything mid-flight without disabling automation. The
ADR-0001/CONTEXT wording that called the master switch "the fleet-wide pause" is
re-sharpened to "automation gate"; the word *pause* now names this freeze.

### One unified Manual Resume, and cold is never refused

Generalise the continuation choice from the single `human-reject` trigger to a
**`manual-resume`** trigger covering pause-resume, escalation-continue, and an
operator retry. All manual resumes flow through one surface:

- Two **always-available** paths — **continue-full** (same Session) and
  **start-condensed** (fresh Session reseeded from a condensed summary) — each
  carrying its warm/cold Cost estimate and the deterministic recommendation
  (`decideAttemptContinuation`, from context size + warmth). The recommended
  path is pre-selected.
- **Lift the warm-only gate** in `steerSettled`: a **cold** Session is offered,
  never refused. Cold only raises the surfaced Cost — it never removes an option
  or blocks the resume (ADR-0001: reuse is always valid).

Resuming continues the **same Attempt** — the Attempt counter advances only on a
failed verdict, and a pause carries no verdict. The condensed path rebinds a new
Session to that same in-flight Attempt; the full path keeps the Session.

**Global resume** touches only `paused` Tasks: it auto-applies each Task's
recommended path silently (no per-task dialog). It never touches `escalated`
Tasks, which stay human-resolved per-ticket.

### The Warmth Countdown ticks on wall-clock

Surface the estimated warm-until as a countdown — `estimatedWarmUntil − now` —
that counts down on **wall-clock**, because it tracks the provider's cache, not
Harmonic's state. A paused Task's countdown keeps ticking: pausing cannot stop
the provider cache decaying. It means "resume within this window or the whole
conversation is re-sent at full cost." Rendered on Task detail wherever a resume
is offered, and as a compact chip on the board card; absent where no resumable
Session exists. A cost signal, never a gate.

### Guardrail budgets suspend while paused

The elapsed-time budget Guardrail (ADR-0002) is **suspended** while a Task is
`paused` and resumes on thaw: a deliberate operator freeze is not the agent
overrunning, consistent with Active-execution duration already excluding
non-agent time (ADR-0008). Token and cost budgets do not grow while frozen, so
they need no special handling.

## Consequences

- A new stored Task state `paused`, added to the ADR-0020 legal-transition table:
  `working → paused` (pause), `paused → working` (resume), `paused → cancelled`
  (operator Cancel). `paused` has no edge to `done` (it must resume and pass
  verification first) and none to `escalated` (a frozen Attempt trips nothing).
  Pause/resume are Task-mutating operations and take the per-Task lock (ADR-0020).
  Crash recovery must rebuild `paused` from the DB like any other state.
- The continuation machinery gains a `manual-resume` trigger; `steerSettled`
  loses its cold-refusal branch and instead surfaces cost. The `human-reject`
  path collapses into the unified surface.
- A latched Global Pause flag (fleet-wide, in-memory rebuilt from state at boot),
  read by both the runner (freeze/hold new Attempts) and the Auto-Runner
  (independent of the master switch).
- The pause steer message becomes a layered Setting Override.
- The Warmth Countdown is a read-only UI projection of existing Session facts;
  no new persisted data.
- Accepted: while Global Pause is latched with the master switch on, freshly
  picked Tasks are picked but sit `paused` rather than executing — coherent with
  the orthogonality decision, and the operator's cue to switch automation off too
  if that is what they meant.

## Extends

ADR-0001 (adds the `paused` state; re-sharpens the master-switch wording),
ADR-0020 (adds `paused` and its edges to the legal-transition table; pause/resume
take the per-Task lock), ADR-0002 (Manual Resume subsumes the warm-Session
`reject { start: true }` exception; adds elapsed-budget suspension), ADR-0005
(generalises the continuation trigger set).
