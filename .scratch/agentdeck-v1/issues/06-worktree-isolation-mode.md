# Worktree Isolation Mode

Status: done

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

- [x] A worktree-mode Run executes in a temporary worktree on branch `agentdeck/task-<id>-run-<n>` off the base branch, and never touches the checkout
- [x] After the Run, the worktree is removed and the branch remains
- [x] Accept merges the Run's branch into the base branch and completes the Task
- [x] A merge conflict aborts cleanly and returns the Task to awaiting-review with the conflict surfaced in the UI
- [x] The awaiting-review inbox shows diffstat and branch name for worktree Runs
- [x] Tests exercise worktree creation, merge-on-accept, and conflict-on-accept against real throwaway git repos created in test setup

## Blocked by

- `05-review-accept-reject.md`

## Comments

**2026-07-14 (agent):** Done. Worktree runs get `agentdeck/task-<id>-run-<n>`
off the working dir's current branch in a temp worktree under the data dir
(src/execution/git.ts + runner prepare/finalize). The run's work is
committed onto the branch before the worktree is removed — the branch is
the artifact. Accept merges via the ReviewService hook (ADR-0002);
conflicts abort the merge, 409 with git's conflict output, task stays
awaiting-review with the detail stored on the run. Reject leaves the
branch. `GET /api/runs/:id/diff` serves branch + diffstat; TaskDetail
shows branch, diffstat, and review feedback. Tests run against throwaway
git repos.
