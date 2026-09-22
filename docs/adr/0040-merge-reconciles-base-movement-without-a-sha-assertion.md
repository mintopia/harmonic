# Decision: The merge reconciles base movement by re-merging, not by a SHA assertion

Status: proposed
Date: 2026-09-22

## Context

`CONTEXT.md`'s **Merge** entry and ADR-0001 describe one merge policy: under the
per-Workspace-repository mutex, an ordinary merge commit of the ticket branch
onto the base, then the deterministic verify commands once on the merged tip.
The entry is explicit that **base movement since the verdict is irrelevant — the
merge commit reconciles the trees** — and that there is **no freshness gate, no
SHA assertion, and no re-verification loop**.

The shipped implementation (`src/execution/merge-policy.ts`, after
"fix: isolate merge policy worktrees", commit `b92f6702`) diverged from that
model in two ways:

1. The isolated merge is built in an ephemeral worktree **off** the base-checkout
   mutex, on a snapshot of the base tip. This keeps the slow agentic
   conflict-resolution turns off the lock (asserted by
   `merge-policy.test.ts` — "does not hold the base-checkout lock while a
   conflict resolve turn runs").
2. The built merge is published to the base branch with
   `Git.casUpdateRef(baseDir, baseBranch, mergeOid, snapshotBaseOid)` — a
   compare-and-swap that is exactly the **SHA assertion** the domain model says
   should not exist.

When two worktree tasks merge onto the same base concurrently, the second's CAS
fails against the first's advanced tip and the task escalated as
`target-advanced` instead of merging — a lost merge and a stuck ticket
(issue #121).

An interim fix wraps the build-and-publish in a bounded rebuild loop
(`MAX_MERGE_ATTEMPTS`): on a CAS failure it re-captures the base tip, rebuilds
the merge onto it, and retries. This **accommodates** base movement and keeps
git history clean (the published merge commit's first parent is always the live
base; discarded attempts are unreferenced), but it still leans on the CAS and
re-runs the whole critical section — including the post-merge verify — on each
retry, which the glossary's "verify once / no re-verification loop" language
discourages.

## Decision

Align the merge mechanism to the domain model: reconcile base movement by
**merging onto the current base**, not by asserting the base SHA.

Under the base-checkout mutex, read the *current* base tip and reconcile the
already-built (and already-verified) merge onto it:

- If the base has not moved since the build snapshot, publish the built merge
  commit directly.
- If it has moved, reconcile the built merge onto the current base with a plain,
  non-agentic merge (`git merge-tree`-style, worktree-free where possible),
  producing the final merge commit. A genuine textual conflict against the new
  base escalates; a clean reconcile publishes without re-running the verify
  commands (the verdict attaches to the Attempt, not to a SHA).

This keeps the agentic conflict-resolution turns off the mutex (preserving the
`b92f6702` behavior and its test) while removing the SHA-assertion CAS and the
re-verification retry loop.

## Consequences

- Removes the `target-advanced` escalation path for ordinary concurrent merges;
  a moving base is reconciled, not rejected.
- Removes the `MAX_MERGE_ATTEMPTS` rebuild loop and the `casUpdateRef` SHA gate
  from the task-merge path; the mutex plus the reconcile merge provide
  correctness without a compare-and-swap.
- Requires a worktree-free reconcile primitive (`git merge-tree`, git ≥ 2.38) or
  an equivalent, and a decision on how a conflict *at reconcile* (base moved into
  the candidate's changes) surfaces — escalate vs. a bounded resolve turn.
- Git history is unchanged in shape: one merge commit per ticket, first parent
  the live base.

## Supersedes

None. Refines the merge mechanism within ADR-0001; supersedes no prior ADR. The
interim rebuild-retry fix for issue #121 in `merge-policy.ts` is the temporary
accommodation this decision replaces.
