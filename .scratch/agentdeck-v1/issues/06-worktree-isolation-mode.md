# Worktree Isolation Mode

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Branch-isolated execution and the git-mutating Accept (ADR-0002). A Task
whose Isolation Mode is worktree executes each Run in a temporary git
worktree on branch `agentdeck/task-<id>-run-<n>`, created off the Working
Directory's current branch. The worktree is removed after the Run; the
branch remains as the artifact.

Accepting a worktree-mode Task merges the Run's branch into its base
branch — acceptance is one click, not a git session. A merge conflict
aborts the merge and returns the Task to awaiting-review with the conflict
surfaced so the reviewer can resolve it deliberately. Rejecting leaves the
branch untouched.

The review inbox gains diffstat and branch info for worktree Runs, so a
reviewer can gauge a change before opening it.

Isolation Mode already exists as a stored per-Task setting with a global
default (from the walking skeleton); this slice makes the worktree value
actually take effect. Direct mode stays unlocked by design — collisions are
the operator's problem.

## Acceptance criteria

- [ ] A worktree-mode Run executes in a temporary worktree on branch `agentdeck/task-<id>-run-<n>` off the base branch, and never touches the checkout
- [ ] After the Run, the worktree is removed and the branch remains
- [ ] Accept merges the Run's branch into the base branch and completes the Task
- [ ] A merge conflict aborts cleanly and returns the Task to awaiting-review with the conflict surfaced in the UI
- [ ] The awaiting-review inbox shows diffstat and branch name for worktree Runs
- [ ] Tests exercise worktree creation, merge-on-accept, and conflict-on-accept against real throwaway git repos created in test setup

## Blocked by

- `05-review-accept-reject.md`
