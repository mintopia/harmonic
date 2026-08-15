---
title: Tracker mirroring & the skills integration
description: How Harmonic interoperates with the mattpocock skills via a data-format and prompt-injection contract, not by bundling them.
---

## The contract

**Harmonic does not bundle or run the mattpocock skills** — the set of
Claude Code skills that includes `/research`, `/implement`, and
`/wayfinder`. It interoperates with them through two contracts, both
external:

- **A data-format contract.** The skills author tickets and label them as
  they work — GitHub issues with `wayfinder:*` labels, `ready-for-agent`,
  `ready-for-human`, and so on. Harmonic *parses* that output and projects
  each ticket onto a **mirrored Task** on a Harmonic board. The skills stay
  the **source of truth** for the ticket's content; Harmonic mirrors it 1:1
  and owns only execution state.
- **A prompt-injection contract.** When Harmonic auto-runs a mirrored Task
  (drive **afk**), it doesn't reimplement the skill's logic. It injects the
  skill's own slash-command — `/research`, `/implement` — as the **Drive
  Prompt**, so the skill does the actual work exactly as it would if a human
  had typed the command.

Across both contracts the skills remain the source of truth. Harmonic is a
mirror and a scheduler: it reflects tracker state onto a board, decides when
an afk Task gets a Run, and hands the real work back to the skills.

See also [Core concepts](/harmonic/using-harmonic/core-concepts/) and the
[Glossary](/harmonic/reference/glossary/) for these terms in context.

## Mechanics

### Origin

A Task's **Origin** records whether it was authored in Harmonic
(**native**) or is a 1:1 projection of a tracker issue (**mirrored**). One
board carries both kinds of Task side by side; only the Origin differs.

### Mirrored Task

A **Mirrored Task** is bound 1:1 to a tracker issue by a tracker ref. The
tracker owns the Task's shape — its prompt, its blocking relationships, its
workflow role — and is the source of truth for all of it. Harmonic owns
only execution state (Runs, Usage) and writes back to the tracker just two
things: claim and close. A re-poll of the tracker upserts the mirrored
Task. A mirrored Task never enters *draft* or *awaiting-review* — those
states belong to native Tasks and the review gate, which mirrored Tasks
bypass entirely.

### Workflow

**Workflow** identifies which mattpocock workflow a mirrored issue belongs
to, derived from its labels:

| Workflow    | Meaning |
| ----------- | ------- |
| `wayfinder` | Charting work: a Map and its decision tickets. |
| `implement` | Build tickets produced by `/to-tickets`. |

These are distinct skills with distinct roles and are never conflated.

### Wayfinder Type

For a Task whose Workflow is `wayfinder`, **Wayfinder Type** further
classifies the decision ticket:

| Wayfinder Type | Meaning |
| --------------- | ------- |
| `research`   | A research ticket. |
| `prototype`  | A prototype ticket. |
| `grilling`   | A grilling ticket. |
| `task`       | A plain decision task. |

Wayfinder Type is null for `implement` Tasks — implementation is a
Workflow, never a Wayfinder Type.

### Drive

**Drive** determines who drives a mirrored Task:

| Drive  | Meaning |
| ------ | ------- |
| `afk`  | Harmonic auto-runs the Task itself. |
| `hitl` | A human drives the Task via the skills; Harmonic surfaces it but never runs it. |

Drive is seeded from labels: `ready-for-human`, `grilling`, `prototype`,
and bare tasks seed `hitl`; `ready-for-agent` and `research` seed `afk`. An
*unclear* signal seeds `afk` — Harmonic attempts optimistically rather than
stalling. The Auto-Runner's entire pick predicate is: pick-eligible iff
`drive ≠ hitl`.

Mirrored Tasks bypass the review gate entirely. There is no Accept/Reject
for a mirrored Task — closure is a tracker act, performed by the
agent-via-skill or by a human.

### Drive Prompt

The **Drive Prompt** is what Harmonic injects to auto-run an afk mirrored
Task. It's a **global** settings template — there is no per-Task override —
built from a workflow slash-command plus a short preamble, filled in from
the Task:

- `{skill}` — derived from the Task's Workflow / Wayfinder Type
  (`research` → `/research`, `implement` → `/implement`)
- `{ref}`, `{url}`, `{title}`, `{body}` — from the mirrored ticket

The preamble instructs the agent to resolve the ticket end-to-end and to
comment on and close it using the tracker doc's `gh` mechanics. Once
launched, the Run streams Run Events like any other Run — there's no
separate visibility path for skill-driven work.

### Escalation

**Escalation** is the runtime `afk → hitl` flip. When an afk Run blocks on
a human prompt — a permission request or a clarifying question — Harmonic
stops the Run, sets the Task's *drive* to `hitl`, and lands the Task back
in *ready*, flagged "escalated to human." The Auto-Runner then skips it
(per the `drive ≠ hitl` predicate) until a person takes over.

### Auto-Retry

On an afk Run failure, Harmonic re-queues the Task rather than giving up
immediately. A failure is any of:

- an error during the Run,
- the skill's own `/code-review` rejecting the work, or
- a clean Run that nonetheless left the ticket *unresolved*.

Harmonic re-queues the Task to *ready* as a fresh Run, still afk, up to a
configurable max (default 1). Exhausting the retries **Escalates** to
`hitl`: the Run is marked *failed*, drive flips to `hitl`, and the ticket
is left open, un-assigned, and flagged. Harmonic never retries silently
beyond the cap.

### Merge Fate

**Merge Fate** governs what happens to a worktree Run's branch once an afk
mirrored Task is resolved (the agent closed its ticket):

| Merge Fate  | Behavior |
| ----------- | -------- |
| `auto-merge` | Default. Merge the branch into base once resolved. A conflict Escalates rather than moving to awaiting-review, which mirrored Tasks lack. |
| `open-PR`    | Push the branch as a GitHub PR; review happens off-Harmonic. |
| `artifact`   | Leave the branch as-is for a human or CI to pick up. |

Merge Fate has a global default with a per-Task override, and only applies
to worktree isolation — direct isolation has no branch to merge. Research
findings branches are always `artifact`, regardless of the configured
default.

## Completion by ticket close

Per [ADR 0011](/harmonic/how-it-works/design-decisions/), an afk mirrored
Run is treated as **successful only when the agent-via-skill has closed its
tracker ticket.** A Run that ends without error but leaves the ticket open
is *unresolved*: it's routed to the failure path — Auto-Retry within the
cap, then Escalate — and its worktree branch is **not** merged.

**Harmonic no longer closes tickets itself.** The one exception is
`open-PR`, which intentionally leaves the ticket open: the PR's own merge
is what closes it.
