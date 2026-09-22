# Decision: The merge reconciles base movement by re-merging, not by a SHA assertion

Status: accepted
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

1. **Reconcile.** Snapshot the base tip `S`, build the merge `M = merge(S, T)`
   off the mutex in an ephemeral worktree exactly as before — `--no-ff`,
   bounded agentic resolve turns, then the post-merge check once. Under the
   base-checkout mutex, read the *current* base tip `B`. If `B == S`, publish
   `M` directly. If `B != S` and `S` is no longer an ancestor of `B` (the base
   rewound), treat it as a reconcile conflict (step 3). Otherwise reconcile:
   `S` is the merge base of `B` and `M`, so a plain, non-agentic
   `git merge-tree --write-tree` of `B` and `M` yields a tree that is `B` plus
   exactly what the build changed, including any conflict resolutions already
   baked into `M`. The final commit's parents are `B` (the live base) and `T`
   (`M`'s own second parent) — never `M` itself, which would make the
   discarded build an ancestor of history.
2. **Publish.** The ref write is git's atomic `update-ref <new> <old>`, where
   `<old>` is the tip just reconciled onto. It guards writers outside the
   mutex (the operator, a direct-mode agent) against overwrite. It is not a
   freshness gate: a miss never rejects, escalates, or re-verifies — it
   re-reads the tip and reconciles the *original* build onto it again,
   unbounded. The verdict never attaches to a SHA.
3. **Reconcile conflict.** A genuine textual conflict at reconcile, or a
   rewound base, releases the mutex and rebuilds: a fresh `criticalSection`
   (new `--no-ff` merge, bounded resolve turns, post-check) runs on a snapshot
   of the new tip, then the mutex and reconcile run again. Bounded to 2
   rebuilds; the 3rd reconcile conflict escalates. A rebuild is a new build,
   so its post-check runs; an ordinary clean reconcile is not a build and
   never re-runs it.
4. **Old git fallback.** `git merge-tree --write-tree` needs git ≥ 2.38. On an
   older git the flag is unsupported, so every base advance takes the rebuild
   path instead of reconciling, bounded generously (8) before escalating with
   a message to upgrade.

This keeps the agentic conflict-resolution turns off the mutex (preserving the
`b92f6702` behavior and its test) while removing the SHA-assertion CAS and the
re-verification retry loop.

## Consequences

- Removes the `target-advanced` escalation path for ordinary concurrent merges;
  a moving base is reconciled, not rejected. `target-advanced` is kept only as
  a readable value for pre-ADR-0040 persisted rows; nothing emits it anymore.
- Removes the `MAX_MERGE_ATTEMPTS` rebuild loop and the `casUpdateRef` SHA gate
  from the task-merge path; the mutex plus the reconcile merge provide
  correctness without a compare-and-swap.
- Requires git ≥ 2.38 for the worktree-free reconcile; older git falls back to
  rebuilding on every base advance instead (bounded to 8, then escalates).
- A reconcile conflict rebuilds at most twice before escalating.
- Adds `reconciled` and `rebuilding` merge-visibility steps alongside the
  existing ones.
- A clean reconcile is never re-verified, so a semantic (non-textual) clash
  between the moved base and the task merges unchecked — this is ADR-0001's
  accepted "verify once" tradeoff, not new to this decision.
- Git history is unchanged in shape: one merge commit per ticket, first parent
  the live base.

## Supersedes

None. Refines the merge mechanism within ADR-0001; supersedes no prior ADR. The
interim rebuild-retry fix for issue #121 in `merge-policy.ts` is the temporary
accommodation this decision replaces.
