# Plan Review Log: The ADR reset — 49 ADRs replaced by 12 definitive ones

Act 1 (grill-with-docs) complete — plan locked, CONTEXT.md core glossary
updated inline (Merge, Attempt, Isolation Mode, Session, Verification), 12/12
open questions resolved with the owner. PLAN_FILE=ADR-RESET-PLAN.md,
LOG_FILE=ADR-RESET-REVIEW-LOG.md, MAX_ROUNDS=5.

Process rule in force (definitive ADR 1): the reviewer must price failure
modes against one-process/one-laptop reality, and MAX_ROUNDS-reached is a
rejection, not an approval.

## Round 1 — Codex (gpt-5.6-terra)

12 findings, VERDICT: REVISE. Summary: (1) history tag not created before
deletion; (2) renumbering needs an in-repo old→new mapping; (3) ADR-0008 had no
destination; (4) in-place critic not revert-recoverable (dirty/untracked
files); (5) 0018 steer delivery-or-409 contract omitted; (6) 0025's four
deletion guarantees lost; (7) "definitive current state" vs pre-migration code;
(8) CONTEXT.md needs semantic rewrite incl. Ticket/Task collision; (9) ADR 8
must state all three metric formulas; (10) ADR 10 must enumerate the job
roster; (11) DESIGN.md needs a semantic pass; (12) the inventory can't be the
acceptance checklist.

### Claude's response

Accepted 1–3, 5–12 as plan revisions: step 0 freezes history behind annotated
tag `adr-reset-2026-08-28`; README carries the full 49-row mapping and a
target-state banner (mirrored on mid-migration ADRs); ADR 9 becomes "Instance,
Workspaces, settings and configuration" absorbing 0008; ADR 6 names the steer
delivery contract; ADR 4 spells out the four deletion guarantees; ADR 8 states
all three formulas at Attempt grain; ADR 10 enumerates retained/retired jobs
with replacements; DESIGN.md added to the semantic sweep; the plan's absorption
lists replace the inventory as acceptance checklist; Attempt timeline rows
renamed "Step" (owner-approved) to end the Ticket/Task collision.

Rejected the enforcement half of (4): a post-critic dirty-tree escalation gate
is machinery the owner explicitly declined under one-laptop pricing ("rely on
the instructions to the agent"). The risk is recorded in ADR 3 as an accepted
tradeoff, diagnosable via ADR 10's every-action-is-logged doctrine.

## Round 2 — Codex

8 findings, VERDICT: REVISE. Summary: (1) steering misfiled under
Conversations, surviving clauses unenumerated; (2) ADR-level map can't prove
clause coverage for the 16 PARTIALs; (3) double assignments (0009→5&8,
0030→4&7) and 0033 misplaced; (4) blanket reference sweep would falsify
history; (5) website's 49-entry ADR index breaks; (6) "current-state" naming
inconsistent with the target-state banner; (7) CONTEXT rewrite not checkable,
Ticket/Task ownership wording unresolved; (8) job roster lacks ownership
boundaries.

### Claude's response

All 8 accepted: 0018 moved to ADR 5 with seven surviving clauses enumerated;
README mapping goes clause-grain for PARTIALs and is named the acceptance
checklist with the plan's absorption lists; 0009 split collection→5 /
metrics→8, 0030 split derivation→4 / source-of-truth→7, 0033 moved to ADR 11;
step 4 rewritten — live normative references only, historical artifacts never
rewritten, website index replaced with a 12-entry index + reset notice; goal
renamed "authoritative target-state ADRs"; CONTEXT.md reconciled heading by
heading with a checklist, Ticket sole owner of branch/worktree, Step as the
timeline unit; each retained job now states inputs, terminal behaviour, and
no lease/phase/merge-journal dependency.

## Round 3 — Codex

5 findings, VERDICT: REVISE: (1) 0030's remaining live clauses unassigned;
(2) mapping still one-row for split LIVE ADRs; (3) comment repointing could
falsely imply compliance; (4) old website deep links break; (5) boot
reconciliation could delete a dirty worktree and lose uncommitted work.

### Claude's response

All 5 accepted: ADR 4 enumerates 0030's claim ownership, scheduler/priority,
capability-gated writes, skip reasons, and human-reclaim rules; clause-grain
mapping rows for every multi-destination ADR; comments re-pointed only where
code already conforms, contradictory ones marked "legacy until ADR-1 epic";
website legacy redirect/explanatory 404 to the reset index and tag; boot
reconciliation auto-removes only clean terminal worktrees and surfaces dirty
or unreadable ones for operator disposition.

## Round 4 — Codex

2 findings, VERDICT: REVISE: (1) ADR 1 renumbering needed a
terminology-and-scope clarification (per-Workspace-repository mutex,
Ticket-owned worktree, Step) without reopening the merge policy; (2)
ADR-0048's warm-Session `reject { start: true }` override silently lost.

### Claude's response

Both accepted: ADR 1 carries the scope clarification; ADR 2 retains 0048 in
full including the warm-Session operator override.

## Round 5 — Codex (final round)

2 findings, VERDICT: REVISE: (1) ADR 1's "never force-started" line vs ADR 2's
warm-Session exception; (2) step 3 still said worktree ownership moves to
"Task" while the ruling names the Ticket.

### Claude's response

Both accepted and fixed in the plan (ADR 1 carries the exception with ADR 2
precedence; step 3 reworded to Ticket ownership with the glossary checklist
extended to Session/Isolation Mode/Working Directory).

## Resolution

MAX_ROUNDS (5) reached without an APPROVED verdict. Per the process rule this
is recorded as a deadlock, not convergence — though the trajectory was
monotonic (12 → 8 → 5 → 2 → 2 findings) and every Round 5 finding was accepted
and applied. Zero disputes remain open: the only rejected finding across all
rounds is Round 1's post-critic enforcement gate, rejected on the owner's
explicit one-laptop pricing decision. Handed to the owner for sign-off.

## Owner clarifications (post-resolution)

1. Warm-Session override rationale: a warm, healthy Session (context under the
   reuse threshold) resumes near-free and skips a cold session's context
   reload, so operator "start now" is offered even over the concurrency cap —
   cheaper and far quicker for small feedback. Recorded in ADR 2; ADR 1
   references it.
2. Vocabulary: Task and Ticket are synonyms — one concept, the board unit.
   With the timeline unit renamed Step, the old Task overload dissolves; the
   Task/Ticket owns branch and worktree. Glossary carries one entry with both
   names.
