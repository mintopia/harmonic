---
Status: accepted
Refined by: [ADR-0030](0030-local-db-source-of-truth-for-agent-work.md)
---

# Parallel Epic execution: worktree Runs off a per-Epic integration branch, landed by a merge train

> **Refined by [ADR-0030](0030-local-db-source-of-truth-for-agent-work.md):** two decisions
> below are superseded — child **eligibility** is now the `ready-for-agent` label (not
> "no assignee"), and Epic structure/frontier is derived from **persisted DB facts** (not
> the live tracker scan). The integration-branch + merge-train design here stands unchanged.

To implement a large feature faster, Harmonic runs the ready children of a
**leaf-most Epic** (a Spec or a Map) **concurrently** in per-Run worktrees, then
**merges them back safely** through a single-writer **merge train** onto a
per-Epic **integration branch**, which lands to `develop` in one go once the
whole Epic is green. The Epic is **derived from the tracker's parent/child
structure** — Harmonic reads it and copes, it never authors it.

We chose this because the parallel-execution pieces already exist but the *join*
does not. The Auto-Runner is already a pool (Machine Ceiling + per-Workspace cap,
ADR-0012), worktree isolation already gives each Run its own branch
(`harmonic/task-<id>-run-<n>`), and afk `auto-merge` already merges a finished
branch into its base. What is missing is everything that makes many finished
worktrees land together without clobbering each other: there is no grouping to
land as a unit, no integration point, and no ordering — today each Run merges
straight into whatever branch its shared working directory happened to have
checked out at spawn (`Git.currentBranch`), guarded only by the per-op repo-lock
for the duration of a single `git merge`, which aborts and Escalates on conflict
with no owner. Merge-back at parallel scale is therefore unproven.

## Decision

- **Grouping is a derived Epic, keyed on the tracker parent ref.** The
  integration unit is the **leaf-most Epic** — the immediate parent of the
  implementation Tasks being run. Membership and wave order are read from the
  tracker: native GitHub sub-issues + native issue dependencies where present,
  `## Parent` / `Part of #<n>` and `Blocked by: #<n>` body lines as the fallback.
  Harmonic authors no Epic structure and stores no new grouping entity.
- **Wave scheduling over the Epic's dependency DAG.** The ready set is the
  wayfinder skill's own **frontier query** — an Epic child is eligible when it
  has no open blocker and no assignee. Concurrency width is the size of the
  current ready set, not the whole Epic.
- **A per-Epic integration branch, owned by Harmonic.** Harmonic cuts an
  integration branch off `develop` for the Epic. Each ready child's worktree is
  cut **from the integration branch**, not from the working directory's current
  branch — which requires a new per-Task `baseBranch` (default = today's
  captured current-branch behaviour). This stays within ADR-0023 (Harmonic owns
  branching).
- **Landing is a single-writer merge train per integration branch.** One landing
  at a time: rebase the finished child branch onto the *current* integration tip,
  then fast-forward. On rebase conflict the child's **own warm Session** gets a
  bounded corrective turn to rebase and resolve; still conflicting → **Escalate**
  (reusing Auto-Retry / Escalation). This is distinct from the per-op repo-lock,
  which only spans a single git op and imposes no order.
- **One atomic land per Epic.** `integration → develop` fires only when every
  member is `completed` **and** a whole-Epic **Verification** passes on the
  integration branch (the union may break even when each child passed alone).
- **Partial failure blocks the whole Epic.** If a member Escalates and cannot
  land, the Epic waits; the operator may explicitly force-land the ready subset,
  never automatically.

## Considered options

- **Harmonic-native stored grouping (a "Convoy"), assigned per Task (rejected).**
  The tracker records no batch id for a `/to-issues` run, which first argued for
  storing the group in Harmonic. Rejected because the real workflow is `/to-spec`,
  whose **parent ticket is already a derivable anchor** — storing a parallel
  grouping would duplicate it and drift from the source of truth.
- **Key on a tracker epic / milestone (rejected).** GitHub has no native epic,
  GitLab epics are Premium (declined, `gitlab.ts`), and milestones aren't parsed.
  The parent ticket (sub-issue / body line) is the identifier that actually
  exists on the board today.
- **Land each child straight to `develop`, as afk auto-merge does today
  (rejected).** No atomicity and a live race on `develop`; a half-done feature
  reaches the trunk one abort at a time.
- **Merge-commit without rebase (today's mechanic, rejected).** A conflicting
  merge aborts with no owner. Rebasing puts the conflict back **on the child's
  branch inside its worktree**, exactly where the resolving Session has context.
- **Recursive whole-spine atomicity (deferred, not rejected).** Integrating at
  the top Epic (a spine Spec) so the entire feature lands atomically would need
  **nested** merge trains (Spec ▸ Spec ▸ Task). Out of scope for v1: the operator
  works in leaf tranches, and the model nests without rework — an Epic's
  integration branch can later target its parent Epic's branch instead of
  `develop`.

## Consequences

- **New per-Task `baseBranch`** (default preserves today's behaviour); worktree
  creation cuts from it. Without it there is no safe way to fork parallel Runs
  off a shared integration point in one working directory.
- **New per-Epic integration-branch lifecycle** and a **new single-writer
  merge-train coordinator**, keyed per integration branch.
- **Reuses** existing machinery: the mirror's frontier query and dependency
  reconciliation (waves), Verification (the whole-Epic seam), Auto-Retry /
  Escalation (conflict self-heal), and the Work Context House Rule (ADR-0022).
- **Derivation targets the current `/to-spec` convention** (native sub-issues +
  `## Parent` / `## Blocked by` body sections). Older prose-only Maps (body
  task-list + "Dependency order:" line, no native edges) can't be derived
  cleanly and **fall back to today's per-Run behaviour** — acceptable, as they
  are already built.
- **First-class dependency on tracker parent/child fidelity.** Missing or messy
  structure degrades gracefully to today's single-Run behaviour; it never breaks.
  Authoring correct tickets is the operator's / an agent's job, by design.
- Redefines afk **Merge Fate** `auto-merge` for an Epic member: it lands via the
  Epic's merge train, not a direct merge into a live base.

## Amendment (2026-08-20, #218): containment fast-path + in-memory backoff, no new persisted entity

The whole-Epic land coordinator kept re-running the (expensive, git-heavy)
verify+land every reconcile tick for an Epic that could never land — one whose
work was **already contained** in the default branch (a prior land whose retire
didn't finish, or a hand-merge), or one whose land permanently failed — spawning
git on the event loop until the server froze. Two guards close this, both keeping
the coordinator's state **in-memory** (this ADR stores no new grouping entity, and
that holds):

- **Containment fast-path (two tiers).** Before verify+land, if the integration
  branch's work is already in the default branch, retire it idempotently and skip
  verify+land entirely. Tier 1 is a cheap ancestor check (`merge-base
  --is-ancestor`) run every poll, before the sticky-escalation hold, so a
  merge-landed-but-escalated Epic is auto-retired rather than lingering (the manual
  branch-retirement that recovery previously required). Tier 2 catches a
  **squash/rebase** land that rewrote the member OIDs so the tip is not a literal
  ancestor even though the content is present — a real 3-way `merge-tree` that adds
  no net content. Tier 2 is heavier, so it runs only past the hold and backoff, on
  a poll already committed to the expensive work (at most once per backoff window),
  never every poll.
- **Hard verify+land backoff.** A per-Epic minimum interval (default 60s) between
  verify+land attempts, so a churning member signature — or the first poll after a
  restart cleared the in-memory guards — cannot spin verify+land on the event
  loop. An operator force-land bypasses it. In-memory only: at most one attempt
  per boot survives a restart, then the hold re-asserts; nothing is persisted.

These two guards bound the *cost* of re-polling a terminal Epic, but the incident's
root cause was a land that could never succeed: an Epic landing into a
checked-out default branch returned `fallback-pr-manual`, escalated permanently,
and was re-attempted every poll. That is removed at its source by the clean-lease
assertion in [ADR-0023](0023-harmonic-owns-branching.md)'s #218 amendment (the land
now succeeds instead of escalating); the containment fast-path and backoff here are
the complementary defence that keeps *any* stuck-terminal Epic from spinning git.

The per-Epic land is already single-flighted by the coordinator's in-flight guard
(a slow verify cannot stack a second attempt for the same Epic). Generalising the
"bound every reconcile/retry loop" principle across the server is #219, not this.
