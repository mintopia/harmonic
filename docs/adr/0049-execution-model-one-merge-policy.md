# Decision: The definitive execution model — verify the branch, merge with a merge commit, verify the base after

Status: accepted
Date: 2026-08-28

## Context

Worktree parallelism was added over 2026-08-20 → 2026-08-28 and produced 148 fix
commits against 98 features, five defensive mechanisms built and demolished
within the week, four overlapping ledgers (~600 nominal state combinations), and
a 3,843-line `runner.ts`. A three-way review (architecture, commit forensics,
ADR drift) traced the churn to one invariant introduced by
`docs/reliability-design.md` and hardened by ADR-0041/0046:

> verification must have seen exactly the tree that gets merged
> (frozen candidate OID, SHA-asserted fast-forward, expected-old-OID CAS).

In a system whose purpose is several parallel tasks merging into one base, that
guarantee makes each task's verification cost a function of how often its
*siblings* merge: every merge invalidates every other in-flight candidate,
forcing rebase + full re-verify — quadratic contention that the freshness gate,
the CAS retry loop, the merge train's stale/resubmit protocol, the carry-forward
verdict, and most of the escalation surface exist to manage. The system already
ran three different policies for the same operation (epic refresh: plain merge
commit, never re-verify; operator Accept: rebase, never re-verify — ADR-0043
calls forced re-verification "the wrong trade"; automated path: full loop),
which is a policy inconsistency, not a safety property.

The review also found that `docs/reliability-design.md` was never approved: its
adversarial review log records five rounds, all `VERDICT: REVISE`, shipped on
`MAX_ROUNDS reached`. Its machinery presumes concurrent uncoordinated writers;
Harmonic is one Node process, one SQLite file, one operator's machine.

This ADR is the definitive statement of the execution model. Where earlier ADRs
conflict with it, this ADR wins.

## Scope and design ceiling

Harmonic runs as **one Node process against one local repository for one
operator**. Anything justified only by concurrent uncoordinated writers —
durable leases, heartbeats, TTLs, compare-and-swap refs, crash-journaled merge
operations, idempotency keys — is out of scope by decision, not omission. Crash
recovery may rely on git's own idempotence and on rebuilding in-memory state
from the DB at boot.

## Decision

### The loop (unchanged intent, now the whole spec)

1. **Tracker sync** mirrors issues, dependencies, and the `ready-for-agent`
   label. A ticket is *ready* when its blockers are closed and it is
   agent-workable (ADR-0041's derived flag).
2. **Scheduler** picks ready tickets in dependency order, up to a configured
   concurrency cap. At most one active execution per work context, enforced as
   a **scheduler predicate** (ADR-0022 as originally written — the lease
   machinery is deleted).
3. **One worktree per Task**, created at task start on a stable
   `harmonic/task-<id>` branch cut from the resolved base (develop, or
   `epic/<ref>` for an Epic member), reused by every Attempt, removed only at a
   terminal disposition (ADR-0046 Amendment 2 — kept).
4. **The Attempt loop**: agent implements and commits → deterministic verify
   commands run in order, fail-fast (failures feed back to the agent) → the
   critic reviews against the ticket's acceptance criteria, given **both the
   base and candidate revisions**. Any failure is a failed Attempt: feedback
   flows into the next Attempt in the same worktree, counter +1;
   `attempts = maxAttempts → escalated` (ADR-0041 — kept).
5. **Merge** (below), then close out: mirror status to the tracker, remove the
   worktree, retire the session.

### One merge policy, everywhere

When the critic passes, the task branch merges into its base under a single
**in-process mutex** (a variable, not a table):

1. Acquire the mutex for the target base branch.
2. `git merge --no-ff <task-branch>` — an ordinary merge commit. The merge
   commit reconciles the trees; base movement since verification is irrelevant
   and is never detected, classified, or alarmed.
3. On textual conflict: a bounded number of agentic resolve turns
   (`merge.conflictResolveTurns`), then escalate with plain-language messaging.
4. **Post-merge check**: run the deterministic verify commands once on the
   merged base tip, still under the mutex.
   - Green → done. Release the mutex.
   - Red → `git revert -m 1` the merge commit, release the mutex, escalate the
     task with the failing output. The base is never left red, and siblings
     never merge onto a red base.

This one policy applies to **every** path: automated task merges, operator
Accept (which becomes "run the same merge now" — no special rebase mode),
develop → epic refreshes, and epic → develop integration. There is no freshness
gate, no re-verification on base movement, no CAS, no retry bound, no merge
train, and no carry-forward verdict, because nothing needs carrying.

**Why this is safe enough**: the branch was verified by the script and reviewed
by the critic; the post-merge check catches semantic collisions between
concurrently merged work on the actual merged tree — which is *more* than the
frozen-tree model checked, since it verifies what the base really becomes; and
`git revert` of a merge commit costs seconds. Pre-merge serializability bought
nothing that the post-merge check does not, at quadratic cost.

**Verification verdicts attach to the Attempt, not to a SHA.** A verdict is
never invalidated by movement elsewhere in the repository.

### Epics

- A per-Epic integration branch `epic/<ref>` is cut from develop; members fork
  off it and merge into it by the policy above (ADR-0024's branch — kept; its
  merge train — deleted).
- Develop is merged into live epic branches on advance, quietly; a refresh that
  cannot complete is recorded and retried on the next trigger, never raised as
  an operator hold (ADR-0046 Amendment 1 — kept).
- When all members are done, whole-Epic verify runs on the integration branch,
  then the epic merges into develop by the same policy (merge commit,
  post-merge check, revert on red). The branch then retires and is deleted.

### Isolation modes

Two declared modes, stored on the task — never inferred from branch shape or
other data:

- **worktree** (the parallel mode): as above.
- **direct**: the agent works in the live checkout and commits onto the base
  branch in place; no isolation machinery, no candidate, no merge step
  (ADR-0046 — kept). Its single checkout serialises to one worker naturally.

### One noun for an execution

**Run collapses into Attempt.** The Attempt is both the loop-iteration ledger
and the execution record: it carries the session, usage, guardrail scoping,
transcript locator, and timeline of steps (rebase-free now: implement → verify
commands → review). Deleted with the Run: the `phase` machine, candidate
OID/ref capture, `execution_chains`, `work_context_leases`, the merge journal
and its point of no cancellation, and the self-heal turn purpose (a dirty tree
at implement-end remains a same-session nudge, per ADR-0041). Ticket states
stay `draft → ready → working → done` + `escalated`/`cancelled` (ADR-0041).

This completes what ADR-0041 declared and ADR-0047 deferred; with the frozen
candidate and phases gone, the coexistence rationale of 0047 no longer applies.

### Guardrails and escalation (kept as-is)

- Attempt counter → cap → `escalated`; one escalation surface, three actions
  (ADR-0041).
- Guardrail trips escalate (ADR-0019).
- Requeues are rejected, never force-started (ADR-0048).
- New escalation triggers from this model: unresolved merge conflict after the
  bounded turns, and a red post-merge check (with its revert recorded on the
  timeline).

### Forensic guards stay banned

ADR-0046's guiding principle is retained and completed: **a moving base is
normal, never a failure, and no runtime mechanism may try to infer agent
misbehaviour or staleness from ref movement** — the week proved such evidence
cannot distinguish concurrency from bugs. The branch-contract escalation
(agent worked outside its worktree) remains, detected from the agent's own
working directory, not from watching refs.

## Consequences

- Deleted outright: the freshness gate and rebase re-entry, carry-forward
  verdicts, expected-old-OID CAS merge and `integrationRetries`, the merge
  train coordinator and its stale/resubmit protocol, the merge journal /
  point-of-no-cancellation machinery, `work_context_leases` (back to a
  scheduler predicate), Run phases and candidate capture, epic-refresh operator
  holds, and branch-sniffing isolation checks. Estimated ~9–11k LOC plus the
  dedicated test files.
- Schema migration: `runs` folds into `attempts`; historical Run rows are
  re-keyed as Attempts (read-only history preserved). This is the only risky
  step and lands last, after the code that read those tables is gone.
- Accepted cost: the merge mutex is held through the post-merge check, so
  merges serialise for the duration of the verify commands. Merges are rare
  relative to task duration; a slow suite can set `merge.postMergeCheck: off`
  (the branch was already script- and critic-verified) and rely on the next
  task's pre-merge verification to surface breakage.
- Accepted risk: between a merge and a red post-merge revert, the base briefly
  contains the broken merge. Nothing else can merge meanwhile (mutex), and the
  revert is automatic.
- History is no longer linear: bases gain merge commits. This is the trade
  that dissolves the contention loop, and it matches how the epic refresh
  already worked.
- CONTEXT.md is reconciled to this vocabulary (Run removed, Attempt as the
  execution noun, merge policy named) in the implementing epic.
- `docs/reliability-design.md` is demoted from specification to risk register:
  its failure-mode inventory stays useful; its mechanisms are void where they
  conflict with this ADR.
- Process rule, recorded so it outlives the week: an adversarial plan review
  that ends `MAX_ROUNDS reached` is a **rejection**, and every review round
  must price failure modes against the deployment reality (one process, one
  laptop, revert costs seconds), with "remove mechanism" as an accepted
  resolution.

## Supersedes

- **ADR-0043** (operator Accept auto-rebases without re-verify) — obsolete: no
  path re-verifies on base movement; `rebaseOnAdvance` and the detached admin
  worktree replay are deleted.
- **ADR-0046** (deterministic base-branch integration) — the optimistic-CAS
  worktree completion, always-re-verify rule, and retry bounds are replaced by
  the single merge policy. Its kept parts are restated here as decisions of
  this ADR: direct-works-in-place, the per-Task worktree (Amendment 2), quiet
  epic refresh (Amendment 1), no forensic guards, and the merge/integrate
  vocabulary.
- **ADR-0047** (Run and Attempt coexist) — the narrowing it anticipated: Run,
  phases, and candidate machinery are deleted; Attempt is the single execution
  noun and carries the only counter.

Amends **ADR-0041** (freshness gate, SHA-asserted merges, and the Rebase Task
are replaced by the merge policy; vocabulary, ticket states, the Attempt loop,
and the escalation surface stand), **ADR-0022** (the lease reframing is
reverted to the original scheduler predicate), and **ADR-0024** (the
integration branch and whole-Epic gate stand; the single-writer merge train and
rebase-then-fast-forward mechanics are replaced by the merge policy).
