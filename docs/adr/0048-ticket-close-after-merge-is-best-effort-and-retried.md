# Decision: Closing the ticket after a Merge is best-effort and retried

Status: accepted
Date: 2026-10-05

Once a Task's work has merged (or there was nothing to merge), a failed
tracker ticket close does not Escalate the Task. The Task settles `done`, is
flagged `ticketClosePending`, and the per-poll `MirrorCoordinator.reconcile()`
retries the close until it succeeds or the ticket is gone.

## Context

Under auto-merge the Runner merges the verified branch, then Harmonic closes the
ticket. A close failure (for example a GitHub API rate limit) escalated the Task
with "merge fate could not be applied" even though the Merge had already
succeeded. The escalation was unrecoverable: the branch was 0 commits ahead of
its base, so operator Accept had no candidate and 409'd, and Reject discarded
merged work while the ticket stayed open (ADR-0001, ADR-0038).

## Decision

- The Merge is the irreversible, load-bearing side-effect. The ticket close is a
  best-effort tracker side-effect and never re-labels a successful Merge as failed.
- A close failure after a successful Merge, or on the no-change path, settles
  the Task `done` and sets `tasks.ticket_close_pending`. A close that succeeds
  leaves it false.
- The operator Accept path is best-effort too. The merge effect runs before the
  ticket-close effect, so failing the Accept on a later close failure would
  re-strand already-merged work: the Task stays escalated and the next Accept
  finds no candidate. The close effect always reports success; the failure is
  flagged pending and retried.
- A failed open-PR fate still Escalates: nothing has merged.
- `reconcile()` retries the close for `done` Tasks with the flag set, using the
  adapter it already holds. It clears the flag on success or when the ticket is
  gone (404 / not found). Retries record no lifecycle event; the first failure
  already recorded `ticket-close-failed`.
- The Task page shows a non-blocking "ticket close pending" pill so the state is
  visible to the operator.

## Consequences

- A rate-limit burst can no longer strand a merged Task behind a dead Accept.
- The tracker may show a merged ticket open for up to a few poll intervals.
- A permanently failing close is retried every poll and logged as a failed
  assignment write by `reconcile()`; it is not escalated.

Supersedes: none. Amends the close-failure clause of ADR-0001's auto-merge fate.
