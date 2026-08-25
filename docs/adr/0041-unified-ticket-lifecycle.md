# Decision: Unified Ticket lifecycle — the Attempt loop, deterministic rebasing, one escalation surface

Status: accepted
Date: 2026-08-25

## Context

The ticket/task workflow has grown three loop mechanisms at three granularities:
self-heal loops *inside* a Run (bounded to one), Auto-Retry creates a *new Run*
on the same Task, and `reattempt` creates a *new Task* linked by `reattemptOf` —
the last of which breaks tracker refs, claims, and history. What a ticket is
doing is split across two layers (Task state + Run phase) that the UI never
shows as one picture; the `validating` phase (candidate snapshot +
branch-contract check) is invisible and widely misread as "doing nothing";
mirrored and native Tasks follow different review paths (ADR-0011 closure signal
vs the human Accept/Reject gate); and merge conflicts surface at land time, after
verification already passed against a stale base. Operators face 8 states × up
to 4 actions each, plus escalation-flag actions layered on top.

The design principle for the rework: **every transition is a deterministic
function of recorded facts**. Agent judgment lives only inside the
implementation and review steps, never in routing.

## Decision

### Vocabulary and hierarchy

- **Ticket** replaces Task as the board unit (native or mirrored).
- **Attempt** = one iteration of a Ticket's implement→verify loop. It carries
  the attempt counter and is the history unit on the Ticket page.
- **Task** is redefined as one individually undertaken step *within* an
  Attempt, each a timeline row with its own logs and outcome:
  **Rebase Task → Implementation Task → Verification Task (one per configured
  command, ordered, fail-fast) → Review Task** (if enabled).
- **Run and Phase are deleted.** "When is a run done" has no answer because Run
  bundled too much; an Attempt ends at its verification verdict.

### Ticket states

`draft → ready → working → done`, plus `escalated` and `cancelled`.

- **Blocked is not a state.** Blockers are a one-to-many edge relation
  (native dependencies and mirrored tracker `blocked-by` both written as
  edges); blocked-ness is derived (open-blocker count > 0), so it can never
  go stale.
- **failed is not a state.** Failure is an Attempt-level fact; at Ticket level
  the work is either looping or `escalated`. A ticket never terminally fails on
  its own — a human closes it.
- **awaiting-review is deleted, and HITL leaves Harmonic.** Everything Harmonic
  runs is autonomous. Human-only tickets (mirrored issues without
  `ready-for-agent`) remain visible — they can block others — but are not
  **agent-workable** (a derived flag: label present AND no open blockers), take
  no actions, and are updated only by mirroring until the tracker closes them.
  Rendered with a distinct HITL icon / muted state colours.

### The Attempt loop

1. **Rebase Task**: rebase the ticket branch onto the current base (epic
   integration branch or develop). Conflicts are work — the agent resolves them
   here.
2. **Implementation Task**: the agent implements and **commits**. Only the
   agent ever commits to the branch; there is no snapshot/candidate machinery.
   A dirty worktree at implement-end gets a same-session nudge ("commit your
   work") and does **not** increment the attempt counter.
3. **Verification Tasks**: `verify.commands[]` run in order, fail-fast.
4. **Review Task**: a single optional critic (harness, model, prompt), only
   after commands pass.

Any failure — command fail, review reject, or review `inconclusive` — is a
**failed Attempt**: feedback flows into Attempt N+1 on the same ticket and same
branch, counter +1. (`inconclusive` no longer escalates directly; burning an
attempt keeps the loop uniform. This revises ADR-0021's fail-safe.)
`attempts = maxAttempts → escalated`. The system never creates a new ticket.

**Session continuation** at Attempt N+1 is a deterministic rule:
`prevSession.contextUsage < contextReuseThreshold AND prevSession warm (fixed
per-provider constant seeded from known cache TTLs)` → continue the same
Session with the feedback appended; otherwise a fresh Session seeded by the
existing condensed-continuation machinery (issue #170) plus the feedback. The
repo is the diff — no diff payload is passed.

### Verification guarantee without the snapshot

Verification records and runs at the **branch head SHA**. Landing asserts the
branch still points at the verified SHA. If the base moved between verify and
land, the ticket re-enters Rebase → Verification **without re-implementing and
without incrementing the counter** (nothing failed). The synthetic
candidate-commit machinery is deleted; the verified-tree-is-landed-tree
guarantee is kept by SHA assertion.

### Merging and freshness

- **Freshness gate**: rebasing onto the base at attempt start (and re-entering
  rebase+verify if the base moved) means verification always runs against what
  will actually land, and landing is conflict-free by construction, serialized
  through the merge train (ADR-0024 kept).
- **Epic integration branches are continuously refreshed**: whenever develop
  advances, merge develop **into** each live `epic/<ref>` (merge, never rebase —
  member worktrees fork off it and a rebase would rewrite history under them),
  serialized through the merge train. A refresh conflict gets one bounded agent
  merge-resolution turn (same shape as the existing land re-merge turn); failure
  escalates the **Epic** into the same attention surface as escalated tickets.
- **Whole-Epic land is kept**: the integration branch merges to develop
  atomically when all members are done, then retires — now clean by
  construction thanks to continuous refresh.
- Branch names: "rebase" is reserved for ticket branches (single-writer, safe);
  integration branches are only ever merged into.

### One escalation surface

A ticket reaches `escalated` only via: (1) attempt counter exhausted,
(2) branch-contract violation (the agent worked outside its branch/worktree —
should never happen, escalate when it does), (3) permanent infrastructure
failure (git circuit-breaker class). Exactly three actions there:

- **Reject with guidance** — guidance becomes feedback, counter resets, loop
  resumes.
- **Accept** — counts as success; the normal success path (land, close,
  cleanup) continues.
- **Close/Cancel** — closes the ticket and runs cleanup (remove branch and
  worktree, close the tracker issue).

These replace the review Accept/Reject, the escalation-flag actions
(Adopt & review, Note to critic, Un-escalate — ADR-0027's escape hatches), and
`reattempt`.

### Mirrored tickets: same machine

One lifecycle for native and mirrored. Tracker interaction (claim, comment on
escalation, close on done) is an **output side-effect, never a control path**.
Ticket closure is no longer the success signal — the verification verdict and
landing are (supersedes ADR-0011's closure-as-success for the automated path).

### Configuration

Global defaults with per-**Workspace** overrides (no per-epic/per-ticket
config): `verify.commands[]`, `verify.review {enabled, harness, model, prompt}`,
`maxAttempts`, `contextReuseThreshold`.

### Visibility

- Board: sections, not state columns — escalated (tickets and Epics) at the
  top, then running, then pending in columns by open-blocker count, grouped
  into Epics; state implied by colour; non-workable (HITL) tickets shown muted
  with a distinct icon.
- Ticket page: the flow of the whole ticket, plus per-Attempt history where
  every Task (rebase, implement, each verify command, review) is a row with its
  command, output, and verdict — "what is verification doing" is answered by
  the timeline itself.

## Consequences

- A migration maps old state to new (`awaiting-review`/`failed` → `escalated`
  or `ready`; Runs' history preserved read-only or re-keyed as Attempts).
- Deleted: `reattempt` + `reattemptOf`, self-heal, Auto-Retry, Run phases, the
  review gate, Drive (afk/hitl) as a stored mode (replaced by the derived
  agent-workable flag), the candidate snapshot machinery, escalation-flag
  actions.
- Revised: ADR-0021 (verdict folding — `inconclusive` now fails the attempt;
  the command verifier becomes an ordered list), ADR-0011 (closure is an
  output, not the success signal), ADR-0027 (escape hatches collapse into the
  three escalation actions).
- Kept: ADR-0024's integration branch + merge train (extended with continuous
  refresh), ADR-0019 (guardrail trips are escalation trigger 2/3), ADR-0025
  (Delete/Dismiss), branch ownership per ADR-0023.
- The event/fact plumbing re-keys from Run to Attempt/Task; the append-only
  fact log remains the coordination spine, since deterministic transitions are
  functions of recorded facts.

## Supersedes

ADR-0011 (closure-as-success on the automated path) and ADR-0027 (escalation
escape hatches). Revises ADR-0021. Extends ADR-0024.
