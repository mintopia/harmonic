# At most one automatic Run per Work Context (the House Rule)

Amended by: 0049-execution-model-one-merge-policy.md — the post-review "durable
lease" reframing below is reverted; the rule returns to what this ADR originally
decided: a scheduler pick predicate. `work_context_leases`, the heartbeat, phase
TTLs, and the `suspect` state are deleted.

A Work Context is a Working Directory plus branch. In direct mode it is the shared
directory on its live branch; in worktree mode it is the Run's own worktree and
branch. The Auto-Runner will not start an afk Run into a Work Context already
occupied by an afk Run that is running or awaiting verification/review. It is a
new pick predicate, enforced alongside the Machine Ceiling and the per-Workspace
concurrency cap.

We chose this because nothing today stops the Auto-Runner from stacking multiple
afk Runs onto the same working directory and branch. In direct mode they share
one directory and would collide; unreviewed work could pile up on top of itself;
and a stray branch left by one Run could silently become the mis-recorded base of
the next (ADR-0023).

## Considered options

- Work Context is directory plus branch (chosen). The natural unit of "where the
  work lands." In worktree mode each Run's branch is unique, so the rule is
  self-satisfied there and mainly protects direct mode and same-context re-runs.
- Work Context is base branch (rejected, stricter). Would serialize every
  afk Run sharing a base branch until the first is merged, killing the worktree
  parallelism that is a feature, not a bug.
- No rule, rely on the concurrency caps (rejected). The caps bound machine
  load, not the integrity of a single context's unreviewed work, which is a different
  concern.

## Consequences

- The Auto-Runner gains a predicate: a Task whose Work Context is occupied stays
  ready (skipped) until the occupant settles or merges.
- The rule mostly bites direct mode and same-context re-runs; worktree Runs off a
  shared base still parallelize, each on its own branch.
- Pairs with ADR-0023: because a context stays locked until settle, a stray
  branch cannot silently become the next Run's base.

## Reconciliation with the v5 design (post-Codex review)

The review reframed the rule from a scheduler predicate to a durable lease. The
"dir+branch predicate" framing above is superseded:

- A `work_context_leases` row, enforced in `Runner.start`/`launchClaimed` (not only
  `pickNext`), with a coordinator-emitted heartbeat, phase TTLs, and expiry to
  `suspect` (never auto-release).
- Key by isolation mode. Direct keys on canonical working-directory
  identity alone (path+branch would wrongly admit two leases on one checkout);
  worktree keys on `{path, branch}`.
- In worktree mode the "at most 1 per context" rule is largely vacuous (unique branch
  per run); it is replaced there by short repository-operation locks around
  worktree create/merge/remove.
- Anti-starvation: operator supersede/unlock, queue diagnostics, and boot
  reconciliation.

See `docs/reliability-design.md` section 0.5.
