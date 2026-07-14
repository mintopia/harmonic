# Accepting a review merges the run's branch (worktree mode)

In worktree Isolation Mode each Run works on its own branch
(`agentdeck/task-<id>-run-<n>`). Accepting the task's review does not just
mark it completed — it merges that branch into the base branch the worktree
was created from. A merge conflict aborts the merge and returns the task to
awaiting-review with the conflict surfaced.

We chose this over "the branch is the artifact, merging is manual" and
"push + open a PR" because the review gate already exists as the human
decision point, and a second manual merge step after acceptance is pure
friction; PR flows assume remotes/credentials we don't want in v1.

## Consequences

- Accept is a git-mutating action. Combined with the agent-review config
  flag (default off), enabling agent review means agents can land branches
  unattended — this is deliberate opt-in autonomy.
- Dependent tasks see the accepted work on the base branch immediately,
  which is what makes worktree mode compose with dependency chains.
