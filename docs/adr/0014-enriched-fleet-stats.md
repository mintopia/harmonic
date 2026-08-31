# Decision: Enriched fleet Stats — task-grain aggregates and colour encoding

Status: accepted
Date: 2026-08-31
Extends ADR-0008 (Usage, Cost, and Stats). The three locked formulas there
(cache hit rate, active-execution duration, failure rate) are unchanged; this
ADR adds task-grain and verification aggregates, a per-workspace grouping, and
one visual-encoding change. Visual source of truth: the Stats design canvas.

## Why extend, not replace

Today's `/stats` route is attempt-scoped and already carries the honest KPI
band, the per-day cost/token/attempt series, reliability, per-model, per-agent,
and tool-token attribution. It misses the fleet views an operator most wants at
a glance: how work *flows* (throughput and self-heal depth), how *verification*
resolves, and *where the spend goes* by workspace. Those are new numbers that
will be trusted and compared across ranges, so — as with ADR-0008's three — the
formulas are fixed here rather than left to the render path.

## Grain: task-level aggregates join the attempt-level route

`/stats` gains task-grain aggregates alongside its attempt-grain ones, over the
same `from`/`to`/`workspaceId` query. Task-grain figures count a Task once by
its settling event, never once per Attempt, so a self-healed Task does not
inflate throughput or cost-per-task.

## The new locked formulas

1. **Tasks merged / day** — a Task counts on the calendar day (server timezone)
   its merge event settled, not the day its first Attempt started. A Task that
   never merged (cancelled, still open) never counts. This is throughput, so the
   denominator is days that actually held merges (first to last, inclusive), the
   same honest-rate rule the fails/day figure already uses.
2. **Attempts per task** — the distribution of Attempts-to-settle over merged
   Tasks, bucketed `1×, 2×, 3×, 4×+`. One is best: a Task that merged on its
   first Attempt needed no self-heal. Open and cancelled Tasks are excluded so an
   in-flight Task's partial count cannot skew the shape.
3. **Cost per merged task** — merged spend ÷ merged Tasks. Spend on Attempts of
   Tasks that were reverted or abandoned is **not** hidden in the denominator: it
   is reported beside the figure as wasted spend, so the split reconciles. Null,
   never a fake zero, when nothing in range could be priced (ADR-0008).
4. **Verification verdicts** — critic verdicts counted `pass / block /
   inconclusive` at verification-attempt grain (a self-heal records one per
   pass, ADR-0003). Command verdicts are counted separately, never folded in.
5. **Gate outcomes** — how settled Tasks left the merge gate: `auto-merged`,
   `escalated` (to human review), `reverted-on-red` (post-merge check failed,
   ADR-0001), as rates over settled Tasks in range.
6. **Guardrail trips by dimension** — trip counts keyed by guardrail dimension
   (`tokens`, `wall-clock`, `cost`, `progress`, `tool-timeout`, ADR-0002). A trip
   counts once per Attempt that tripped it; an Attempt tripping two dimensions
   counts in both.
7. **Per-workspace breakdown** — the existing aggregates (cost, billable tokens
   split input/output, Tasks, failure rate) grouped by Workspace, so a single
   range answers where spend and failures concentrate. Ordered by cost.

## Tokens are never one scalar

Reaffirming ADR-0008's honest-numbers rule at the surface: no aggregate ever
reports a single combined token total. Input, output, cache-read, and
cache-write price differently (cache-read is near-free; cache-write is not), so
they are always shown split — as the per-class stacked breakdown, or as separate
billable input/output columns. The headline figures stay cost and billable I/O.

## Colour encoding: token classes go categorical

The per-model token-breakdown bars move from the monochrome ink-opacity ramp to
a **warm categorical set** — input gold, output orange, cache-read coral,
cache-write magenta. This is a deliberate exception to the "Two Voices"
monochrome rule (which existed so a cache segment could not pre-read as a
running/blocked *status*): the four hues are chosen to sit clear of Harmonic's
status palette (running amber, merged green, fail pink, await indigo), so a
token class still cannot be mistaken for a state. Colour is load-bearing here —
it is how the class split reads at a glance — and applies wherever the breakdown
renders: the fleet Stats page and the per-Attempt block on the Task page.

## Colour encoding: attempt activity goes to a teal intensity ramp

The fleet Stats page carries a GitHub-style attempt-activity heatmap — a weeks ×
weekdays calendar of attempts/day — coloured on a five-step ramp: a neutral empty
tile, then four teal steps that darken with intensity on Paper and brighten on
dark. Like the categorical token colours above, this is a deliberate, named
exception to the "Two Voices" rule that reserves teal for the action/tooling
voice. Two things keep the encoding from pre-reading as an action or a *ready*
state: it is a legended quantitative ramp (a Less→More scale, not a single lit
accent), and the empty day is a neutral tile, never a faint teal — so "no
activity" can never read as a dim *ready*. Colour is load-bearing: the ramp *is*
how activity density reads at a glance. The five `--hm-heat-*` tokens are the
source of truth, gated in `contrast.test.ts` for a monotonic ramp and a
distinguishable empty tile in both themes.

The window is a fixed trailing span (26 weeks), deliberately independent of the
KPI range toggle, so the rhythm of activity reads the same whatever range the
headline figures are on. It is built from the existing per-day attempt count
(`series[].attempts`) over the shared `/stats` reader path — no new field.

## Consequences

- The stats reader and route encode these formulas exactly; this ADR is the
  reference they cite, alongside ADR-0008 for the attempt-grain three.
- The `/stats` response schema (zod, the OpenAPI source of truth per ADR-0011)
  grows the task-grain, verification, guardrail, and per-workspace fields; the
  generated `openapi.json` regenerates from it.
- Task-grain aggregation reads settle events, so it prices only what settled in
  range; unsettled Tasks contribute nothing until they merge.
- The colour change is a token-level design decision, applied once at the
  breakdown component so both surfaces stay identical.
