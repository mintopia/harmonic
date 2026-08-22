# afk completion requires a resolved ticket

**Status: superseded by [ADR-0021](0021-verification-gate-replaces-agent-review.md) (implemented in #139).**
Under the close-after-verify model, `finish_task`, not the agent closing the
ticket, is the execution-complete signal; Harmonic runs verification, lands per
Merge Fate, and **closes the ticket itself** (auto-merge: merge then close;
open-PR: leave open; artifact: leave open). A ticket closed before Harmonic lands
is **premature**: it is reopened and the Task Escalated, and it no longer stands
in for a completed Run. The `isResolved` gate and the ticket-close-as-signal
described below are gone; the *unresolved* failure path survives, but its trigger
is a missing `finish_task` signal, not an open ticket.

An afk mirrored Run is treated as **successful only when the agent-via-skill has
closed its tracker ticket**. A Run that ends without error but leaves the ticket
open is *unresolved*: it is routed into the failure path (Auto-Retry within the
cap, then Escalate to a human), and its worktree branch is **not** merged.
Harmonic no longer closes tickets itself.

We chose this because the previous rule silently completed soft failures. Under
it, "clean completion" meant only that the harness process exited without throwing. An
agent that gave up cleanly (e.g. "this dependency isn't done yet", `stopReason:
end_turn`, exit 0) had its Task marked `completed`, its ticket force-closed by
Harmonic's fallback, and under `auto-merge` its half-done branch merged, with no
retry and no escalation, because those only existed on the error path. The skills
are already the source of truth and close the ticket on real success (the Drive
Prompt instructs it), so "did the agent close the ticket?" is the honest success
signal that was already available and ignored.

## Considered options

- **Clean exit = success, Harmonic fallback-closes (rejected).** The prior
  behavior. Simple, but a soft failure is indistinguishable from success, so
  wrong work completes and merges.
- **Inspect run output for failure markers (rejected).** Brittle and
  harness-specific; the agent's phrasing is not a contract.
- **Require the agent to have closed the ticket (chosen).** A binary,
  harness-agnostic signal the skills already produce. Not closed ⇒ unresolved ⇒
  retry/escalate.

## Consequences

- `AutoDrive.onCompleted` gains an `'unresolved'` outcome; the Runner routes it
  through `settleFailedOrRetry` (Auto-Retry cap → Escalate). The `fallbackClose`
  helper is gone.
- The resolved check reads the ticket state (`adapter.readTicket`) once at
  Run finish; a read error counts as unresolved (fail safe, not false-complete).
- **open-PR is exempt:** it intentionally leaves the ticket open (the PR's own
  merge closes it), so its success stays "a PR was created."
- An agent that does the work but forgets to close its ticket will now retry then
  escalate rather than complete. Acceptable: a human closes it, and the skills'
  contract is to close on success.
- Pairs with the GitHub body-line dependency fix (issue #46): with real
  Dependency edges, an afk Task blocked on an unfinished dependency stays
  *blocked* and is never picked, so it cannot reach this path in the first place.
