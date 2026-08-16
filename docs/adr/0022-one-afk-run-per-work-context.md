# At most one automatic Run per Work Context (the House Rule)

A **Work Context** is a Working Directory + branch — in *direct* mode the shared
directory on its live branch, in *worktree* mode the Run's own worktree and
branch. The Auto-Runner will **not start an afk Run into a Work Context already
occupied by an afk Run that is running or awaiting verification/review**. It is a
new pick predicate, enforced alongside the Machine Ceiling and the per-Workspace
concurrency cap.

We chose this because nothing today stops the Auto-Runner from stacking multiple
afk Runs onto the same working directory and branch. In direct mode they share
one directory and would collide; unreviewed work could pile up on top of itself;
and a stray branch left by one Run could silently become the mis-recorded base of
the next (ADR-0023).

## Considered options

- **Work Context = directory + branch (chosen).** The natural unit of "where the
  work lands." In worktree mode each Run's branch is unique, so the rule is
  self-satisfied there and mainly protects direct mode and same-context re-runs.
- **Work Context = base branch (rejected — stricter).** Would serialize *every*
  afk Run sharing a base branch until the first is merged, killing the worktree
  parallelism that is a feature, not a bug.
- **No rule, rely on the concurrency caps (rejected).** The caps bound machine
  load, not the integrity of a single context's unreviewed work — a different
  concern.

## Consequences

- The Auto-Runner gains a predicate: a Task whose Work Context is occupied stays
  *ready* (skipped) until the occupant settles or merges.
- The rule mostly bites direct mode and same-context re-runs; worktree Runs off a
  shared base still parallelize, each on its own branch.
- Pairs with ADR-0023: because a context stays locked until settle, a stray
  branch cannot silently become the next Run's base.
