# Decision: Verification is always visible with an explicit status, and the ticket exposes a chronological lifecycle timeline

Status: accepted
Date: 2026-08-26

Amended by ADR-0044 (2026-08-26): the always-visible verification read model gains a `planned` state — see Decision A.

## Context

Two review surfaces exist in the ticket page today but read as absent to an
operator:

1. **The critic (and command) verification is effectively invisible.** The
   `Verification` panel (`web/src/components/TicketPage.tsx`) renders per-verifier
   verdicts and a lazily-fetched critic session transcript (ADR-0040), but only
   when (a) a Run is selected *and* (b) that Run recorded at least one
   verification attempt — otherwise it returns `null`. Nothing on the attempt
   timeline signals that a critic ran, blocked, or was never invoked. When the
   critic is disabled in settings, or short-circuited because there was no frozen
   candidate to review (`Runner.noVerifiedHeadVerdict` — "verifier configured but
   no candidate"), the operator sees nothing at all and cannot tell "the critic
   passed", "the critic was skipped", and "no critic is configured" apart. The
   critic transcript expander compounds this: whenever `hasTranscript` is false
   it shows a bare "Critic session log unavailable" with no reason.

2. **There is no chronological record of the steps a ticket went through.**
   `AttemptTimeline` (`web/src/components/ticket/AttemptTimeline.tsx`) is an
   *attempt/task tree* keyed on attempt number, not a time-ordered lifecycle. The
   raw material for a real timeline already exists in the DB (`runEvents`,
   `conversationEvents`, lifecycle events, verification attempts, escalation and
   operator dispositions, landing) but nothing folds it into one ordered,
   timestamped sequence. An operator auditing "what actually happened to this
   ticket" has to reconstruct it by clicking through each attempt and run.

3. **The transcript does not distinguish the main agent from subagents.**
   `TranscriptTimeline` renders every `session_update` event in one flat stream.
   The harness already attributes each event to its spawning agent — a
   subagent's events carry `_meta.claudeCode.parentToolUseId` (the `Agent`/`Task`
   tool-use id that spawned it), read today by `parentToolUseId` in
   `process-tree-model.ts` and folded into the usage process tree — but the
   transcript view discards that attribution, so a reader cannot tell the root
   agent's work apart from a subagent's, or see which subagent produced what.

The authoritative source for *what verification should have run* is
`resolveVerifiers(ws, config)` (`src/domain/setting-override.ts`), which returns
the resolved command and `critic: {…} | null`. Reconciling that against the
recorded `verification_attempts` for a run is enough to classify every verifier
without new persistence. This decision does not change how verification runs or
how critic transcripts are captured (ADR-0021, ADR-0040) or the lifecycle model
(ADR-0041) — it is purely about *surfacing* what those already produce.

## Decision

**A. Verification is always shown, with an explicit per-verifier status.**

Introduce a derived, per-run verifier status the UI can always render, computed
by reconciling `resolveVerifiers()` (configured) against the recorded attempts:

- `passed` / `failed` / `inconclusive` — an attempt was recorded; use its verdict.
- `skipped` — the verifier was configured but produced no attempt for this
  candidate (e.g. no frozen candidate to review, gate short-circuited).
- `disabled` — the verifier is not configured (critic off in settings / no
  command). Still rendered, as a muted "disabled" row, never omitted.

**Amended by ADR-0044.** The read model gains a `planned` state, distinct from
`skipped`: before a run reaches the `verifying` phase, each configured verifier is
`planned` — it will run — and flips to `passed`/`failed`/`inconclusive` as attempts
are recorded, or to `skipped` if the gate short-circuits it. This drives the per-run
*verification plan* surface: the ordered, gate-on-pass sequence (commands in order,
then the review) a run will execute, reconciled against `resolveVerifiers()`.
`skipped` keeps its meaning — configured, verification reached, but no attempt
produced for this candidate.

This status is exposed on the run verification read model
(`GET /api/runs/{id}/verification-attempts`) and on the task attempt timeline
read model (`GET /api/tasks/{id}/attempts`) so both the per-run panel and the
attempt rows can show it. The `Verification` panel no longer returns `null`; it
always renders one row per configured-or-disabled verifier. Each attempt row in
`AttemptTimeline` carries an at-a-glance verification chip (critic + command
outcome) so the review is visible without drilling into a run. When a critic
transcript is unavailable, the expander states *why* (not captured / critic did
not run / disabled) instead of a bare "unavailable".

**B. The ticket exposes a chronological lifecycle timeline.**

Add a ticket-scoped, time-ordered projection that folds the existing event
sources — attempt/run lifecycle transitions, phase changes, verification
outcomes (including skipped/disabled), guardrail trips, escalation, operator
Accept/Reject dispositions, and landing/merge — into one ordered, timestamped
list, served from a new read-model endpoint. A new lifecycle-timeline surface on
the ticket page renders it as the chronological/audit view, explicitly distinct
from the attempt-centric `AttemptTimeline` tree (which stays as the
attempt-switching control). The projection is derived on read from persisted
events; it introduces no new write path.

**Placement (locked with Jess).** The lifecycle timeline lives in the **main
panel**, below the ticket description and stats and *above* the per-Attempt
section — it is not a right-rail element. The right rail stays exactly three
sections in order: **Attempts** (`AttemptTimeline`), **Files Changed**
(`RunRail`), **Actions** (`Gate`) — no timeline in the rail. Separately, the
main-panel "helpful guides" (the hints telling the operator a ticket has
something to do) render **below** the breadcrumb bar, never above it.

**C. The transcript distinguishes the main agent from subagents.**

`TranscriptTimeline` groups and labels events by their agent of origin, using the
existing `parentToolUseId` attribution: root-agent events read as the main
stream; a subagent's events are visually attributed to — and grouped under — the
`Agent`/`Task` call that spawned it (subagent name/type resolved from that tool
call), with obvious visual separation (indentation / a labelled lane / a header
per subagent span). Attribution that the harness does not provide (non-Claude
harnesses, or events with no `parentToolUseId`) degrades gracefully to the main
stream rather than guessing. This is a rendering change over data already present
on `RunLogEvent.payload`; no new persistence or read-model field is required
unless a harness needs its own attribution mapping.

## Consequences

- The headline gap closes: a disabled or skipped critic is now a visible,
  labelled state rather than silence, and the critic's verdict is legible from
  the timeline without opening a run.
- Two ticket surfaces now describe the same work from two angles (attempt tree
  vs. chronological log). They must stay clearly differentiated in the IA (Paper,
  ADR-0034) or they will read as redundant; the lifecycle view is framed as the
  audit/history trail, the attempt tree as the interactive selector.
- `skipped` vs `disabled` classification depends on `resolveVerifiers()` matching
  what the runner actually resolved at run time; settings changed after a run
  could in principle misclassify a historical run. Accepted: status is a
  best-effort reconciliation for display, not a persisted fact. If this proves
  misleading, a follow-up can persist the resolved-verifier set onto the run.
- The lifecycle projection reads several event tables per ticket load; it must be
  bounded and cheap (server-side fold, no per-event round trips) to fit the
  async-DB event-loop guarantees (ADR-0029/0036).
- Subagent attribution is currently Claude-harness-specific
  (`_meta.claudeCode.parentToolUseId`); other harnesses fall back to a flat main
  stream until a per-harness mapping is added. The transcript grouping must not
  break the existing flat rendering when attribution is absent.
- No schema migration and no change to verification or critic execution; this is
  additive read-model + UI work, keeping behaviour green slice by slice.

## Supersedes

None. Builds on ADR-0021 (agent critic), ADR-0040 (critic transcript locator),
ADR-0041 (unified ticket lifecycle), ADR-0034 (Paper).
