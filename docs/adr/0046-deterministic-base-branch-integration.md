# Decision: Deterministic base-branch integration — direct works in place, worktree reconciles by optimistic CAS, no forensic guards

Status: accepted
Date: 2026-08-27

## Context

A run's base branch (develop, or an epic integration branch) moves underneath
running work for reasons Harmonic does not and cannot control: an external push
or pull, an unrelated merge, another run's integration. A string of fixes tried
to police this with **forensic guards** — code that infers agent misbehaviour
after the fact from git side-effects — and with **edge-triggered** reconciliation
that only reacts to Harmonic's own moves and so rots when the base moves
externally. The result was fragile and produced cryptic operator-facing errors
(e.g. `an agent committed onto the canonical checkout … advanced <a> → <b>
outside any Harmonic land`) that fired on entirely legitimate base movement.

The worst offenders: the worktree "canonical guard" (`captureCanonicalGuard` +
its escalation) failed innocent runs whenever the base branch happened to move
during the turn; and direct-isolation completion ran a branch **classifier**
(`recoverAndLand` / `landReMerge` / `evaluateReMergeResult` /
`planDeterministicRecovery`) that adjudicated an already-captured candidate and
escalated on "ambiguous". Both are inference where none is needed.

Guiding principle adopted with the product owner: **a moving base is normal, never
a failure. Correctness must never depend on the base holding still, and the
integration path must be deterministic** — pure git plus the configured verify
command, with the only agentic step being explicit merge-conflict resolution.

## Decision

**Direct isolation works in place, with no isolation machinery.** The agent works
in the live checkout and commits directly onto the base branch; its commits are
children of the checkout's HEAD, so the branch only ever moves forward. When
verification (deterministic verifiers + the configured agent verify) passes, the
work is done — it is already where it belongs. There is no candidate ref, no
CAS, no merge, and no classifier. **Delete** `detachForDirectRun`,
`captureDirectHead`, `recoverAndLand`, `landReMerge`, `evaluateReMergeResult`,
`planDeterministicRecovery`, `restoreDirectCheckout`, and
`reattachBareDetachedHead`. Direct isolation stays a supported mode and remains
the default; its single checkout naturally serialises to one worker per
branch-context. A pre-existing dirty tree (changes the agent did not make) is
tolerated and never fails the run.

**Worktree isolation reconciles at completion by optimistic concurrency.** When
work is done: freeze the candidate `C`; read the current base tip `B`; rebase `C`
onto `B` in a throwaway checkout producing `M`; **verify `M`** (exactly what will
become the new base tip); publish by compare-and-swap on the base ref (`B → M`,
expected-old `B`). A CAS miss means the base moved — a **normal** outcome, not an
error — so the loop re-reads and retries, bounded to `K` attempts, single-flight
(one integration attempt per task, never overlapping). Exhausting `K` defers to
the next scheduler poll or escalates with a plain message; it never tight-retries.
This is an evolution of the existing `freshenForLanding` re-entry loop, not a new
engine.

**Auto-driven runs always re-verify a replayed rebase.** There is no
"skip re-verify when the base's changed paths don't intersect the candidate's"
shortcut on the autonomous path: disjoint file sets are not a safe proxy for
semantic independence (a base signature change, a dependency bump, a new or
changed test all break a candidate without touching its files). Only a pure
no-op fast-forward (`M == C`, nothing replayed) skips. The re-verify runs the
**deterministic verifiers only**; the **AI critic runs once on the candidate and
is not re-invoked per retry** — a rebase replays the same diff the critic already
reviewed, and the integration behaviour it does not exercise is what the
deterministic verifiers catch. This deliberately does **not** adopt the
"overlap guard" mused in ADR-0043's consequences for the autonomous path; that
ADR's rebase-without-re-verify remains in force **only** for operator Accept,
where a human vouches for the result.

**Content conflicts** in the rebase get a configurable `N` bounded agentic
resolve-turns, then escalate — always with plain-language messaging, never a raw
git conflict dump.

**Bounds and vocabulary.** `K` (rebase/CAS retries, default 5) and `N`
(conflict-resolution turns, default 2) are global settings with per-task override
(mirroring `isolationMode`). The term **"land" is removed entirely** in favour of
**"merge"** (a task's work into its base) and **"integrate"** (the epic
integration branch's role) — across code, lifecycle events, telemetry span types,
persisted DB values (via a one-shot data migration), and API fields (with the
co-deployed web UI updated in the same change; there is no external API consumer).

**Observability.** A moving base is recorded but never alarmed: each retry emits a
fire-and-forget lifecycle event carrying the attempt index (`3/5`), rendered as a
single quiet collapsed line whose prominence rises only as it nears `K`; a
terminal run-fact records the final count. A second worker attaching to an
already-claimed direct checkout emits a debug-level log line (not surfaced).

The epic integration side is already correct and is reused unchanged: `epic/<ref>`
cut from develop, develop merged into the epic, level- and edge-triggered
refresh, members based on `epic/<ref>`, epic integrated into develop fast-forward.

## Consequences

- The two failure classes behind the recent churn are removed at the root: the
  worktree canonical guard and the direct-mode classifier are deleted, so
  legitimate base movement can no longer fail an innocent run.
- Issue #198's reattach hazard (`checkout -f` stranding a detached HEAD)
  **evaporates**: direct mode no longer detaches, so there is nothing to reattach.
- **Accepted tradeoff (direct mode):** with no isolation, if verification fails
  and corrective turns are exhausted, the unverified commits remain on that
  checkout's branch. This is acceptable because direct mode is explicitly the
  single-worker, operator-owns-the-checkout mode; work that must be kept off the
  branch until green belongs in worktree mode.
- **Accepted cost (worktree mode):** re-verifying every replayed rebase can add
  latency when the base churns, but it is bounded by `K` and single-flight, and
  the alternative — publishing green-but-broken code to win the race — is the
  fragility being removed.
- The rename is a breaking change to persisted and API values; because Harmonic is
  the sole consumer, it is migrated cleanly with no compatibility shim and no
  residue rather than translated at a boundary.
- Verification always inspects exactly the tree that gets published (`M`), closing
  the general rebase-without-re-verify gap on the autonomous path.

## Amendment (2026-08-27): the epic refresh is a moving base too

The original decision (above, "The epic integration side is already correct and
is reused unchanged") left the `develop → epic/<ref>` refresh escalating to an
operator hold after its one bounded corrective turn could not reconcile — or when
no member was free to host that turn. In practice this fired constantly on any
in-flight Epic whose base moved under it: an Epic with most members still
unstarted would surface a red "Merge escalated — awaiting you" the moment develop
advanced into a file the Epic also touched, and, because the hold cleared only on
a completed integrate or branch deletion, it never released even after the drift
was reconciled.

That contradicts this ADR's guiding principle. A `develop` advance under an
integration branch **is** a moving base, and a moving base is normal, never a
failure. So the principle now extends to the epic refresh: a refresh that cannot
fast-forward (a conflict, or no member free to host the corrective turn) is
**recorded quietly and retried on the next trigger, never raised as an operator
hold**. The epic-level escalation is reserved for the **integrate gate** — every
member merged, then whole-Epic verify and the `--ff-only` integrate into develop —
which is member-gated and where an irreconcilable drift genuinely surfaces. The
one bounded corrective turn (issue #315) still runs; only its loud, sticky,
never-releasing escalation is removed.

## Supersedes

None. Refines ADR-0041's landing-freshness gate and preserves ADR-0043
(operator-Accept rebase-without-re-verify) while declining to extend its
path-overlap shortcut to the autonomous path. Reuses the epic integration model
of ADR-0024. Renames the vocabulary used by earlier ADRs; their historical text
is left as written.
