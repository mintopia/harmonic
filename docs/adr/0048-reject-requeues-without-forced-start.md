# Decision: Reject with guidance requeues; it never force-starts the next Attempt

Status: accepted
Date: 2026-08-28

Amends ADR-0041 (the "Reject with guidance … loop resumes" clause).

## Context

ADR-0041 defined Reject with guidance as: guidance becomes feedback, the counter
resets, and **the loop resumes**. In the implementation that "resume" was a
direct `Runner.start()` fired synchronously from the reject path
(`resumeWithGuidance`), *bypassing the Auto-Runner's Machine Ceiling and the
per-Workspace caps* (ADR-0012). Two problems follow:

- **It ignores capacity.** A reject spawns a Run immediately even when the fleet
  is at `maxConcurrentRuns`, and even when the Auto-Runner is disabled entirely
  (the default). Rejecting N escalated tickets starts N concurrent Runs at once.
- **It removes operator control.** An operator triaging a backlog of escalated
  tickets has no way to reject (record guidance, requeue) *without* also
  re-running the work on the spot. Warm-Session reuse — the one reason to start
  *right now* rather than let the scheduler pick it up — is exactly the case
  where an immediate start has value, yet the old path gave the operator no say.

## Decision

Reject with guidance **requeues only**: it records the guidance as feedback,
resets the attempt budget, and returns the Ticket to `ready`. It does **not**
force-start the next Attempt. From `ready`, the next Attempt begins by the
normal rules:

- **Capacity picks it up.** The Auto-Runner starts it when there is a free slot
  under the Machine Ceiling / Workspace cap — "if there is capacity, it runs,
  regardless." With the Auto-Runner disabled, it waits for a manual start.
- **A warm Session may be started immediately, by choice.** When the Ticket has
  a live, still-**warm** Session to reuse (the `GET /tasks/:id/continuation`
  estimate, ADR-0041's deterministic continuation rule), the reject surface
  offers the operator an explicit **"start now"**. Chosen, it force-starts
  immediately — an operator override, so it bypasses the capacity ceiling the
  same way the manual Run action does — so perishable Session warmth is not lost
  waiting in the queue. A cold or absent Session offers no such option; the
  Ticket simply requeues.

`start` is an optional flag on `POST /tasks/:id/reject` (default `false`); the
warm-Session "start now" is the only caller that sets it.

## Consequences

- Bulk-rejecting a backlog is safe: N rejects leave N Tickets `ready`, and the
  scheduler drains them within the configured concurrency, instead of a stampede
  of N simultaneous Runs.
- The default (Auto-Runner off) no longer runs a rejected Ticket until a human
  starts it — this is the intended triage behaviour, and the warm-Session
  "start now" covers the case where the operator does want it moving now.
- The continuation preview endpoint (issue #170), previously computed and served
  but unused by the reject dialog, now drives the "start now" affordance.
- ADR-0041's "loop resumes" is narrowed to "loop requeues; it resumes by
  capacity or by an explicit warm-Session start." The rest of ADR-0041 stands.

## Supersedes

None. Amends ADR-0041.
