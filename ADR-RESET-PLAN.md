# Plan: The ADR reset — replace all 49 ADRs with 12 definitive current-state ADRs

_Locked via grill-with-docs — by Claude + Jess, 2026-08-28. Terms per CONTEXT.md._

## Goal

Replace the accumulated 49-ADR trail (amendment chains, superseded halves,
v5-reliability residue, and decisions the codebase no longer honours) with 12
**authoritative target-state ADRs** (they describe the decided target until the
ADR-1 implementation epic ships; where code lags, the ADRs win), renumbered
0001–0012, so that a
reader — human or agent — finds exactly one authoritative document per topic.
The old files are deleted (git history preserves them); a `docs/adr/README.md`
records the 2026-08-28 reset. CONTEXT.md is reconciled to the same vocabulary.
Source material: the inventory at
`/tmp/claude-1000/-home-workspace-harmonic/448dae98-09a8-4bc0-9869-a27f9856c00e/scratchpad/adr-reset-inventory.md`
(classification of all 49: 26 LIVE, 16 PARTIAL, 5 DEAD, 2 STALE-UNKNOWN, with
per-clause absorption mapping) and the already-written
`docs/adr/0049-execution-model-one-merge-policy.md`.

## Approach

0. **Freeze history first**: commit the exact pre-reset ADR set (including the
   0049 file and the amendment notes added 2026-08-28) and create annotated tag
   `adr-reset-2026-08-28` on that commit; record its SHA in the new
   `docs/adr/README.md`. Deletion happens only after the tag exists.
1. Write the 12 definitive ADRs in `docs/adr/`, numbered 0001–0012:
   1. **Execution model: verify the branch, merge with a merge commit** — the
      existing 0049, renumbered, with a terminology-and-scope clarification
      (no change to the accepted merge policy): the merge mutex and policy
      apply **per Workspace repository** (one Node process, many Workspaces,
      each its own repo); the **Task** owns its branch and worktree (Task and
      Ticket are synonyms — see the vocabulary ruling in step 3); the Attempt
      timeline unit is the **Step**; and its "requeues are rejected, never
      force-started" line carries the narrow warm-Session exception spelled
      out in ADR 2 (`reject { start: true }`), ADR 2's wording taking
      precedence.
   2. **Guardrails, branch ownership, and the escalation surface** — absorbs
      0019 (trip→escalate), 0023 (Harmonic owns branching, branch-contract
      guardrail; v5 reconciliation and #218 clean-lease amendment dropped),
      0041's escalation surface, 0048 in full (reject requeues to `ready`,
      never force-started, **including the warm-Session operator override**:
      `reject { start: true }` starts the continuation immediately when a
      warm, healthy Session can be reused — healthy meaning its context is
      under the reuse threshold. Rationale, recorded in the ADR: a warm resume
      is near-free and skips reloading context into a cold session, so for a
      one-line piece of feedback it is both cheaper and far quicker; that is
      why the operator may start it even over the concurrency cap).
   3. **Verification and the critic** — absorbs 0021 core + amendments
      (v5 reconciliation dropped), 0040 (critic transcript locator), 0041's
      Attempt-loop verification. New decisions: the critic reviews **in place**
      with no enforcement machinery — no disposable checkout, no
      permission-mode forcing, restraint by prompt instruction; recovery is
      `git revert`. No pre-merge cleanliness facts. **Accepted tradeoff,
      recorded**: an instructed-but-unrestricted critic can in principle dirty
      the shared worktree or run external tools; this is accepted per the
      one-laptop pricing (owner decision), made diagnosable — not prevented —
      by ADR 10's logging doctrine (every critic turn is a logged Operation).
   4. **Tracker mirroring and ticket sourcing** — absorbs 0011's live residue
      via 0041 (closure is an output), 0014 (workspace-only tracker config,
      backfill shim removed), 0017 (resolved tracker in-memory — seam kept
      deliberately), 0025 with **all four deletion guarantees spelled out**
      (non-running guard; atomic tombstone-plus-delete; dependent
      re-derivation; `task_removed` firehose event), 0030's *tracker-derivation and scheduling* clauses (DB facts as source;
      `ready-for-agent` label eligibility; local claim ownership; DB-driven
      scheduler/priority behaviour; capability-gated status writes; surfaced
      skip reasons; the human-reclaim-by-label rule — only its
      DB-as-source-of-truth persistence principle lives in ADR 7, and ADR 4
      cross-references it for mechanics), one-line `Blocked by:` parsing. (0033's running-amber sub-AA exception
      is UI guidance and lives in ADR 11.)
   5. **Harness integration over ACP, Sessions, and steering** — absorbs 0001
      (ACP-only), 0009's *collection* clause (usage parsed from native session
      logs — the metric definitions live in ADR 8), 0020 core (Sessions
      first-class, `session/load` resume — verified wired: `AcpDriver.load`,
      `session-resume.ts`, `decideAttemptContinuation`; keepalive/reattach and
      reliability-design references dropped), 0041's continuation rule, and
      0018 execution steering with its surviving clauses enumerated: ACP
      injection first, boundary fallback, capability latching, operator-only
      access, scoped-key exclusion, continuation-budget treatment, and the
      delivery contract (delivered before settle or rejected with 409, never
      accepted and silently dropped; injected/queued/delivered facts kept).
   6. **Conversations and interactive permissions** — absorbs 0006, 0007.
      ADR-0032 (held permission requests for autonomous executions) is
      **dropped**, not carried: never built, not doctrine; a future need is a
      fresh decision. (Execution steering lives in ADR 5.)
   7. **Persistence, the database, and event-loop discipline** — absorbs 0016
      (FK-disabled migrations, reworded for libsql), 0029 (async libsql,
      single writer), 0030's DB-as-source-of-truth, 0036 (local queries inline,
      heavy reads off-thread), the event-loop guarantee, and the principle
      "every reconcile loop is bounded" (the sole survivor of 0024's #218
      amendment beyond a one-line ancestor-check idempotence guard before epic
      integration).
   8. **Usage, Cost, and Stats metrics** — absorbs 0009/0010 (live persisted
      snapshot **kept as-is**, ~10s cadence), 0031 (tool aggregates from native
      JSONL — including its aggregate/transcript rules), 0009's *metric*
      clauses, 0035 (cost computed once and stored — supersedes 0010's
      never-stored clause), 0028 re-based with **all three metric formulas
      stated**: active-execution duration = sum of agent time only (time not
      spent with agents never counts); the cache-hit-rate denominator; and the
      failure-rate numerator redefined at Attempt grain (a failed Attempt
      counts; a review rejection is a failed Attempt).
   9. **Instance, Workspaces, settings and configuration** — absorbs 0008 in
      full (one instance, many Workspaces; global Auto-Runner master switch and
      Machine Ceiling semantics; Workspace lifecycle; `workspaceId` firehose
      scoping), 0044 (scope-declaring schema, three-state inheritance — the
      definitive settings model), 0012's live residue (Machine Ceiling,
      clamping), 0004 (DB is the sole config home).
   10. **Observability: Operations and Scheduled Jobs** — absorbs 0037 in
       full: Operations as OTel spans, AlwaysOn, **exhaustive logging kept as
       doctrine and strengthened** — an action without a span/log entry is a
       defect (known gaps exist today and are teardown-epic work). Absorbs
       0038: jobs framework and persistent last-run registry kept; job runs
       are Operations (per-run spans/logs visible). The ADR **enumerates the
       post-reset job roster explicitly**, and for each retained job states
       its inputs, terminal behaviour, and that it has **no lease, phase, or
       merge-journal dependency**: tracker mirror sync (tracker API + ticket
       facts → mirrored rows); session retirement sweep (idle Sessions past
       their disposition → retired; never touches worktrees); boot
       reconciliation (DB tickets vs on-disk worktrees/branches → recreate to
       match Ticket state; **auto-removes only clean worktrees of terminal
       Tickets** — a dirty or unreadable worktree is surfaced for operator
       disposition, never deleted, so a crash cannot cost uncommitted work); usage snapshot finalisation. Retired
       with named replacement — work-context-lease sweep (concept deleted;
       nothing replaces it), review-SLA sweep (replaced by Ticket-owned
       worktree retention: removal only at terminal disposition).
   11. **Web UI and API conventions** — absorbs 0034 (Paper), 0005
       (OpenAPI from zod), 0045 (paginated lean list endpoints, server-side
       search), 0015 (dependency graph: elkjs + SVG, data via 0045), 0042's
       live residue (verification always visible, ticket timeline — including
       the planned verifier state and degraded subagent attribution), 0033
       (running-amber sub-AA accessibility exception), 0026
       replaced: **Epic Peek is retired**; an Epic renders as its board of
       open tasks, extended for epics without open ones — active tasks shown,
       a rail below the columns for closed tasks, colour-status pips top-right
       covering all tasks; a complete epic ready to merge shows a
       steps/progress bar of the integration.
   12. **Distribution, tooling, and the docs site** — absorbs 0013 (Astro
       Starlight + Pages + OpenAPI-fed reference), 0039 (oxlint). Distribution
       decision updated: **npm package** `@mintopia/harmonic` (npx from the
       registry); 0003's npx-from-GitHub is superseded and `private: true`
       stays gone.
2. Delete all 49 old ADR files (including 0049 once renumbered as 0001) in the
   same change; add `docs/adr/README.md` containing: what the set is, the
   reset date, the tag/SHA from step 0, a **clause-grain mapping table** —
   one row per old ADR where it maps whole to one destination, and one row per
   *clause* for every ADR that is PARTIAL **or** splits across destinations
   (e.g. 0009 → 5+8, 0030 → 4+7); each clause → its new home ADR, or
   "dropped: <reason>" — and a **status banner**: these ADRs describe the
   decided target state; until the ADR-1 implementation epic ships, code,
   tables, and API fields still carry pre-reset vocabulary (Run, phases,
   candidate) — the ADRs win. Each new ADR whose subject is mid-migration
   carries the same one-line banner. This mapping table, together with the
   absorption lists in this plan, is the **acceptance checklist**.
3. Reconcile CONTEXT.md fully — a **semantic rewrite in the same change**, not
   a token sweep. Already done inline during the grill: Merge (one policy),
   Attempt (single execution noun; Run/Phase/Candidate/Self-heal deleted),
   Isolation Mode (per-Ticket worktree, declared), Session (worktree ownership
   moved to the Ticket), Verification (verdict attaches to Attempt); the
   heading checklist must also re-word the Session, Isolation Mode, Working
   Directory, and related execution entries to Ticket ownership. Remaining:
   Run→Attempt through Usage/Cost/Process Tree/Auto-Runner/Guardrail/Work
   Context entries; rewrite "Parallel Epic execution" (merge train → one merge
   policy, Epic board presentation); Statistics section (all three formulas);
   and the vocabulary ruling (owner-decided): **Task and Ticket are
   synonyms** — one concept, the board unit, "Ticket" being its tracker-facing
   flavour; the Task/Ticket owns branch and worktree; the Attempt timeline
   unit is renamed **Step**, which is what dissolves the old Task overload.
   The glossary defines them as one entry with both names. Execution: work
   through CONTEXT.md **heading by heading** with a checklist (every `###`
   section marked reconciled/unchanged), not by grep; the checklist must
   re-word the Session, Isolation Mode, and Working Directory entries to this
   ownership ruling.
4. Re-point **live normative references only**: docs/, AGENTS.md, PRODUCT.md,
   and code comments get the new numbers **only where the code already
   conforms to the target ADR**; a comment on not-yet-torn-down machinery
   (freshness/CAS/Run) is instead marked `legacy until ADR-1 epic — see
   docs/adr/README.md mapping` so nothing falsely claims compliance.
   **Historical artifacts are never rewritten** — SQL migrations, test
   fixtures, review logs, and persisted Ticket/journal text keep their old
   numbers, which stay resolvable through the README mapping and the step-0
   tag. **DESIGN.md gets a semantic reconciliation pass** (it embeds
   merge-train and Epic-Peek assumptions that number-swapping cannot fix), and
   MISTAKES.md/PONYTAIL-DEBT.md entries that reference dead machinery get a
   one-line resolution note. The website's hard-coded ADR index is replaced
   with a 12-entry target-state index plus a reset notice linking the mapping
   and tag; old ADR-page deep links get a legacy redirect (or an explanatory
   404 page pointing at the reset index and tag) — they must never resolve
   silently into wrong-numbered pages.
5. Demote `docs/reliability-design.md` to a risk register with a header note
   (per definitive ADR 1); `docs/reliability-plan-review-log.md` stays as
   history.
6. **Acceptance checklist**: this plan's absorption lists (which encode the
   owner's grill decisions), not the inventory file, are the coverage
   checklist; the inventory remains source material only, since it predates
   the grill and still contains reversed choices (merge-cleanliness facts,
   Epic Peek, npx-from-GitHub). Verification of the reset = every LIVE clause
   in the inventory either appears in a new ADR or is named in the README
   mapping as dropped-by-decision.

## Key decisions & tradeoffs

- **Full replacement over incremental supersession**: one authoritative doc per
  topic beats a correct-but-layered trail; the cost — losing in-file history —
  is paid by git and the README pointer.
- **12 topics** as listed above (owner-approved). Definitive ADR 1 is the
  already-accepted execution model.
- The 12 previously-open questions are all resolved (owner's answers recorded
  above in their topics): drop 0032; no merge-cleanliness facts; critic
  unrestricted-but-instructed, in place; OTel full-strength; jobs
  registry kept with per-run logs; ancestor-check only; duration = agent time;
  npm distribution; session resume verified live; live-usage snapshot kept;
  tracker seam kept; Epic Peek retired for the extended Epic board.
- One-laptop pricing is the recurring judge: enforcement machinery is dropped
  (critic sandboxing, held-permission plumbing) where instruction + `git
  revert` suffice, while **visibility machinery is kept or strengthened**
  (OTel, job registry, live usage) — the owner's stated priority.

## Risks / open questions

- The 16 PARTIAL ADRs must be split clause-by-clause; the inventory's mapping
  is the checklist, and every LIVE clause must land in exactly one new ADR
  (reviewer should verify coverage, not just structure).
- Old-number references exist outside docs/adr (code comments, website docs,
  persisted ADR mentions in tickets); the sweep in step 4 has to be grep-based
  and complete or readers chase dangling numbers.
- CONTEXT.md's remaining sections still use pre-reset vocabulary until step 3
  completes; interim readers may see mixed terms.

## Out of scope

- The code teardown itself (deleting the freshness gate, CAS, merge train,
  leases, Run→Attempt schema migration) — that is the implementation epic
  driven by definitive ADR 1, planned separately.
- Rewriting website/ user documentation beyond re-pointing ADR references.
- Any change to 0049's accepted execution model — Act 2 reviews this *plan*,
  not that decision.
