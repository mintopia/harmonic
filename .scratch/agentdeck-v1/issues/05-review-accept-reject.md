# Review: Accept / Reject

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

The human review gate. Finished Tasks sit in awaiting-review until a
reviewer decides: Accept completes the Task (terminal); Reject fails it,
with the reviewer's feedback recorded. A failed Task — whether rejected or
errored — can be re-queued to ready with optional feedback appended to its
prompt, so retries learn from what went wrong.

The awaiting-review kanban column functions as the reviewer's inbox: each
card leads to the Run's result and event history so the review loop is
tight. (Diffstat and branch info for worktree Runs arrive with the worktree
slice.)

This slice covers direct-mode Tasks only — Accept here just completes; the
git-mutating Accept for worktree mode is the next slice (ADR-0002).

## Acceptance criteria

- [x] Accepting an awaiting-review Task moves it to completed (terminal)
- [x] Rejecting an awaiting-review Task moves it to failed with the feedback stored
- [x] A failed Task can be re-queued to ready, optionally with feedback appended to its prompt, and the appended prompt is what the next Run executes
- [x] Accept/Reject are available only on awaiting-review Tasks
- [x] The awaiting-review column links each Task to its latest Run's events and result
- [x] REST-seam tests cover accept, reject-with-feedback, and re-queue-with-feedback flows

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`

## Comments

**2026-07-14 (agent):** Done. `ReviewService` (src/domain/review.ts):
accept completes (terminal), reject fails with feedback stored on the
reviewed run (`review`/`reviewFeedback`/`reviewedAt` columns). Requeue
(from issue 03) appends optional feedback to the prompt; a test asserts the
retry's harness receives the appended prompt via the stub's echo. Accept
takes an async hook so the worktree slice can plug in the ADR-0002 merge.
UI: Accept/Reject on awaiting-review cards, feedback prompts on
Reject/Re-queue.
