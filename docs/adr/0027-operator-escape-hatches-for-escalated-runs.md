---
Status: accepted
---

# Operator escape hatches for escalated runs: Adopt-and-review + Note-to-critic

When Verification returns `inconclusive` or `block`, `combineVerdicts` fail-safes to Escalate (ADR-0021): the afk run flips to hitl, the task lands back at `ready`+`escalated`, and its candidate (frozen at `refs/harmonic/candidate/run-N` / `run.candidateOid`) is stranded. The operator then has no way to (a) accept and land that existing candidate without a full, expensive builder re-run, or (b) give the critic corrective feedback — the only feedback channel (Re-attempt) feeds the Builder, never the critic. This leaves two common cases stuck: an escalated task with a good candidate that just needs human approval, and a critic verdict that could be overturned by a note or context clarification. Refs: issue #191, #174, #133, ADR-0021, ADR-0002.

## Decision

We add two new operator-only escape hatches, both reusing the existing candidate without a fresh builder run:

**1. Adopt-and-review** — a new authorized state transition `escalated → awaiting-review`. An operator action re-parks the escalated run's EXISTING candidate non-terminal (`run.state:'running'`, `phase:'review'`, review-SLA stamped) and moves the task to `awaiting-review`, clearing the escalated flag — WITHOUT a fresh builder run. The existing human Accept (accept-anyway) then lands it through the journaled LandingCoordinator (ADR-0002). Available whenever a task is `escalated` and its last run has a candidate, regardless of origin (native or mirrored) — a deliberate operator override of the mirrored "closure is a tracker act" default.

**2. Note-to-critic** — a human feedback field that re-runs ONLY the critic (not the builder) against the existing candidate, with the note carried as TRUSTED preamble inside the critic's existing nonce/deny-all injection containment (ADR-0021 preserved). The fresh critic verdict is re-folded with the latest per-verifier verdicts via `combineVerdicts`. On `proceed` the task parks at `awaiting-review` for a human Accept (NEVER auto-lands — a human-nudged critic pass does not auto-merge); any non-pass keeps the task escalated. The fail-safe holds: the note cannot force a pass, only a genuine `pass` verdict parks it.

## Considered options

- **Costly rebuild path only.** Re-attempt feeds the builder, which re-runs the full flow and discards the candidate. Economical for the builder-critic feedback loop where the builder must change; wasteful when the candidate is sound and the human just needs to approve it, or when the critic should re-judge given a clarification. *Rejected:* it abandons the candidate and re-runs at ~$6 cost per escalation.

- **Auto-land escalated tasks with a strong candidate (rejected).** Removes the human gate entirely on a well-formed candidate. Violates the fail-safe from ADR-0021: inconclusive is treated as fail-safe because false-completing is worse than an extra human look. An *escalated* task has failed that gate; auto-landing it removes the human override that makes escalation meaningful.

- **Single new action: Adopt-and-review only (rejected).** Handles the case of a good candidate needing approval, but leaves the critic-feedback case (a blocked verdict that could be overturned by new context) with no remedy short of rebuild. A note to the critic is cheap and completes the escape-hatch pair.

- **Single new action: Note-to-critic only (rejected).** Handles critic feedback but requires a critic pass before the task can move to awaiting-review; an escalated task with a candidate the builder intended as good but the critic blocked cannot skip to review without critic re-judgment, which the operator might not have enough domain knowledge to influence. Adopt-and-review is the "approve this work" escape hatch.

- **Adopt-and-review with auto-land on critic pass (rejected).** If a note to the critic causes a `proceed`, skip awaiting-review and land directly. Violates the human-in-the-loop principle: a critic pass guided by an operator note is not an automated pass; a human must still accept it.

## Consequences

- Two missing human-in-the-loop escape hatches for the escalate/block verification outcomes now exist, avoiding ~$6 builder re-runs that also discard the candidate.
- `escalated → awaiting-review` is a new legal edge in the review/verification state machine that ADR-0021 governs; the task and run state charts must document this transition.
- Adopt-and-review deliberately lets a mirrored task reach the human Accept gate, overriding the usual mirrored bypass (a mirrored Task's closure is normally a tracker act, ADR-0002) — an operator-only override, not the default path.
- Note-to-critic preserves ADR-0021 containment and fail-safe; it never auto-lands. The note is a TRUSTED preamble to preserve integrity; operator misuse is out of scope (the operator is authorized to land anyway).
- The Run state machine gains a new non-terminal parked state (`phase:'review'`, `state:'running'`) reusing the same SLA and Accept/Reject paths as native awaiting-review runs; ADR-0002's journaled-landing mechanism is unchanged, though the disposition precedence table gained a rank (below).
- Landing an adopted run required a new terminal disposition `operator-accept`, ranked `operator-cancel > operator-accept > escalate`, so an operator's explicit Accept overrides the automatic `escalate` still on the reused run's fact log (reliability-design §0.3 updated). ADR-0002's journaled-landing mechanism is unchanged; only the disposition precedence table gained a rank.
