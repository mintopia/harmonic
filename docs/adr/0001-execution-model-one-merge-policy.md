# Decision: The execution model — verify the branch, merge with a merge commit, verify the base after

Status: accepted
Date: 2026-08-28
Reconciled: 2026-10-02. Execution teardown shipped; later merge, pause, Epic and escalation refinements are incorporated below.

Part of the 2026-08-28 ADR reset (see README.md). Implemented by
[epic #390](https://github.com/mintopia/harmonic/issues/390), closed 2026-08-29.
Current refinements: ADR-0018/0023 for stored Epics, ADR-0027 for pause,
ADR-0028/0037 for staged Verification, ADR-0038 for escalation, and
ADR-0039/0040 for merge placement and publication.

## Context

Worktree parallelism was added over 2026-08-20 → 2026-08-28 and produced 148 fix
commits against 98 features, five defensive mechanisms built and demolished
within the week, four overlapping ledgers (~600 nominal state combinations), and
a 3,843-line `runner.ts`. A three-way review (architecture, commit forensics,
ADR drift) traced the churn to one invariant introduced by
`docs/reliability-design.md` and hardened by the pre-reset ADRs 0041/0046:

> verification must have seen exactly the tree that gets merged
> (frozen candidate OID, SHA-asserted fast-forward, expected-old-OID CAS).

In a system whose purpose is several parallel tasks merging into one base, that
guarantee makes each task's verification cost a function of how often its
*siblings* merge: every merge invalidates every other in-flight candidate,
forcing rebase + full re-verify — quadratic contention that the freshness gate,
the CAS retry loop, the merge train's stale/resubmit protocol, the carry-forward
verdict, and most of the escalation surface existed to manage. The system also
ran three different policies for the same operation (epic refresh: plain merge
commit, never re-verify; operator Accept: rebase, never re-verify; automated
path: full loop) — a policy inconsistency, not a safety property.

`docs/reliability-design.md` was never approved: its adversarial review log
records five rounds, all `VERDICT: REVISE`, shipped on `MAX_ROUNDS reached`.
Its machinery presumes concurrent uncoordinated writers; Harmonic is one Node
process, one SQLite file, one operator's machine. It is demoted to a risk
register: its failure-mode inventory stays useful; its mechanisms are void
where they conflict with this ADR.

This ADR is the definitive statement of the execution model.

## Scope and design ceiling

Harmonic runs as **one Node process against local repositories for one
operator** — many Workspaces, each its own repository (ADR-0009). Anything
justified only by concurrent uncoordinated writers — durable leases,
heartbeats, TTLs, freshness-gated compare-and-swap protocols, crash-journaled merge operations,
idempotency keys — is out of scope by decision, not omission. Crash recovery
may rely on git's own idempotence and on rebuilding in-memory state from the DB
at boot. ADR-0040 permits an atomic ref-update guard solely to prevent a
publication race; a mismatch causes a re-merge, never a freshness failure.

## Vocabulary

- **Task** (synonym: **Ticket** — one concept, the board unit; "Ticket" is its
  tracker-facing flavour). The Task owns its branch and worktree.
- **Attempt** — one iteration of a Task's implement→verify loop, and the single
  execution noun: it carries the session, usage, guardrail scoping, transcript
  locator, and its timeline. Run, Phase, Candidate, and Self-heal are deleted
  concepts.
- **Step** — one row of an Attempt's timeline. Task pipeline stages are
  rebase, implementation, verification, and review (ADR-0038). Named
  commands and critics have individual Verification Attempt records.
- Task states: `draft → ready → working → done`, plus `escalated` and
  `cancelled` (and `paused`, an operator execution freeze added by ADR-0027).
  Blocked-ness and agent-workability are **derived**, never stored. There is no *failed* state (failure is an Attempt-level fact; a Task
  loops or escalates, and only a human closes it) and no *awaiting-review*
  (everything Harmonic runs is autonomous; human-only tickets are visible but
  not agent-workable).

## Decision

### The loop

1. **Tracker sync** mirrors issues, dependencies, and the `ready-for-agent`
   label (ADR-0004). A Task is *ready* when its blockers are closed and it is
   agent-workable.
2. **Scheduler** picks ready Tasks in dependency order, up to the configured
   concurrency caps (Workspace cap under the Host Ceiling, ADR-0009). At
   most one active execution per work context (working directory + branch),
   enforced as a **scheduler pick predicate** — the pre-reset lease machinery
   (`work_context_leases`, heartbeats, TTLs, `suspect`) is deleted.
3. **One worktree per Task**, created at task start on a stable
   `harmonic/task-<id>` branch cut from the resolved base (develop, or
   `epic/<ref>` for an Epic member), reused by every Attempt, removed only at a
   terminal disposition.
4. **The Attempt loop**: the agent implements and **commits** (only the agent
   ever commits to the branch; a dirty worktree at implement-end gets a
   same-session nudge and does not increment the counter) → the deterministic
   verify commands run in order, fail-fast → the critic reviews against the
   ticket's acceptance criteria, given **both the base and candidate
   revisions** (ADR-0003). Any failure — command fail, review reject, or
   review `inconclusive` — is a **failed Attempt**: feedback flows into the
   next Attempt in the same worktree, counter +1;
   `attempts = maxAttempts → escalated`. The system never creates a new
   ticket.
5. **Merge** (below), then close out: mirror status to the tracker, remove the
   worktree, retire the Session.

Session continuation at Attempt N+1 is deterministic (ADR-0005): continue the
prior Session iff its context usage is below `contextReuseTokenLimit` and it is
warm; otherwise a fresh Session seeded by the condensed continuation plus the
feedback. The repo is the diff — no diff payload is passed.

### One merge policy, everywhere

Task and Epic integration use `runMergePolicy`. ADR-0039 and ADR-0040 refine
the original locked-merge design into this sequence:

1. Snapshot the base tip and build an ordinary `git merge --no-ff` in an
   ephemeral administrative worktree. Agentic conflict resolution is bounded
   and runs outside the repository mutex.
2. Run the configured post-merge check in that same worktree. A failing check
   records a post-merge-red escalation; the failed build is discarded without
   publication.
   Sequential commands share their files and artifacts.
3. Acquire the repository mutex and reconcile a moved base with the original
   build. A clean reconcile keeps the original verdict; it does not repeat
   verification. A textual conflict or rewound base takes ADR-0040's bounded
   rebuild path.
4. Publish with an atomic ref update against the tip just reconciled. A write
   race rereads and reconciles again, rather than treating normal base movement
   as stale work.
5. If the target is checked out in the operator's base checkout, synchronize
   changed paths while preserving local edits, then retire the temporary
   worktree (ADR-0039).

Automated Task completion, final-Step Accept, Epic refresh, and Epic
integration share the merge policy. Earlier-Step Accept advances the pipeline
under ADR-0038. There is no freshness gate, merge train, or carry-forward
verdict. Verification verdicts attach to the Attempt, not to a SHA.

The accepted concurrency tradeoff is explicit: a clean reconciliation onto a
base that moved after the build check is not checked again. A semantic clash
introduced solely by that reconciliation can therefore pass publication;
ADR-0040 records this choice. A rebuild does run its own post-merge check.

### Epics

- A per-Epic integration branch `epic/<ref>` is cut from develop; worktree-mode
  members fork off it (per-Task `baseBranch`) and merge into it by the policy
  above. Direct-mode members commit in place like any direct Task, and an Epic
  whose members are all direct has no integration branch: it completes in
  place when every member is done (ADR-0039). Epic membership comes from the tracker's parent/child structure (ADR-0004).
  Harmonic stores leaf-most Epic lifecycle and integration facts
  (ADR-0018/0023), but authors no tracker grouping structure.
- Develop is merged into live epic branches on advance, quietly; a refresh that
  cannot complete is recorded and retried on the next trigger, never raised as
  an operator hold. (A cheap ancestor check before integration keeps the
  operation idempotent when the epic's work is already contained in the
  default branch.)
- When all members are done, whole-Epic verify runs on the integration branch,
  then the epic merges into develop by the same policy (merge commit,
  post-merge check, discard on red). The branch then retires and is deleted.
- Partial failure blocks the whole Epic: an escalated member holds the epic's
  integration until an operator acts.

### Isolation modes

Two declared modes, stored on the Task — never inferred from branch shape or
any other data:

- **worktree** (the parallel mode): as above.
- **direct**: the agent works in the live checkout and commits onto the base
  branch in place; no isolation machinery, no candidate, no merge step. Its
  single checkout naturally serialises to one worker. A pre-existing dirty
  tree is tolerated and never fails the run. Accepted tradeoff: if
  verification fails and corrective turns are exhausted, the unverified
  commits remain on that checkout's branch — direct mode is explicitly the
  single-worker, operator-owns-the-checkout mode.

### Guardrails and escalation (kept — see ADR-0002)

- Attempt counter → cap → `escalated`; one escalation surface, three actions.
- Guardrail trips escalate.
- Requeues are rejected, never force-started — with the narrow warm-Session
  operator exception spelled out in ADR-0002 (`reject { start: true }`), whose
  wording takes precedence.
- New escalation triggers from this model: an unresolved merge conflict after
  the bounded turns, and a red post-merge check (with its revert recorded on
  the timeline).

### Forensic guards stay banned

**A moving base is normal, never a failure, and no runtime mechanism may try
to infer agent misbehaviour or staleness from ref movement** — the pre-reset
week proved such evidence cannot distinguish concurrency from bugs. The
branch-contract escalation (agent worked outside its worktree) remains,
detected from the agent's own working directory, not from watching refs
(ADR-0002).

## Consequences

- Deleted outright: the freshness gate and rebase re-entry, carry-forward
  verdicts, expected-old-OID CAS merge and `integrationRetries`, the merge
  train coordinator and its stale/resubmit protocol, the merge journal /
  point-of-no-cancellation machinery, `work_context_leases` (back to a
  scheduler predicate), Run phases and candidate capture, epic-refresh
  operator holds, and branch-sniffing isolation checks. Estimated ~9–11k LOC
  plus the dedicated test files.
- The completed schema teardown replaced `runs` with `attempts` under the
  clean-break policy. Historical Run rows were discarded, not migrated or
  re-keyed (epic #390, child #388).
- Conflict resolution and build verification occur outside the repository
  mutex; reconciliation and publication serialize per repository (ADR-0040).
- A red build check is not published. Clean reconciliation can introduce an
  unchecked semantic collision with intervening work, as accepted above.
- History is no longer linear: bases gain merge commits. This is the trade
  that dissolves the contention loop.
- Process rule, recorded so it outlives the week: an adversarial plan review
  that ends `MAX_ROUNDS reached` is a **rejection**, and every review round
  must price failure modes against the deployment reality (one process, one
  laptop, revert costs seconds), with "remove mechanism" as an accepted
  resolution.

## Absorbed at the reset

Pre-reset 0049 (this document's prior form); 0041's vocabulary, states,
Attempt loop, continuation rule; 0022's original scheduler predicate; 0046's
surviving parts (direct-works-in-place, per-Task worktree, quiet epic refresh,
no forensic guards, merge/integrate vocabulary); 0024's integration branch and
whole-Epic gate; 0002's merge-on-success intent. See README.md for the full
mapping.
