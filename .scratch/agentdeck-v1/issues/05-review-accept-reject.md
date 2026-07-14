# Review: Accept / Reject

Status: ready-for-agent

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

- [ ] Accepting an awaiting-review Task moves it to completed (terminal)
- [ ] Rejecting an awaiting-review Task moves it to failed with the feedback stored
- [ ] A failed Task can be re-queued to ready, optionally with feedback appended to its prompt, and the appended prompt is what the next Run executes
- [ ] Accept/Reject are available only on awaiting-review Tasks
- [ ] The awaiting-review column links each Task to its latest Run's events and result
- [ ] REST-seam tests cover accept, reject-with-feedback, and re-queue-with-feedback flows

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`
