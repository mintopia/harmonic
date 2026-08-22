---
Status: accepted
---

# Stats metric definitions: cache-efficiency denominator, active-execution duration, and failed-only failure rate

The Stats page publishes six headline metrics that people will trust and compare
across ranges. Three of them had a genuine alternative, a different formula that
is defensible and, in two cases, more flattering. Once code and a cached UI
encode a number, changing it silently reprices history and breaks comparisons.
So we lock the three contested choices here, before the KPI-band ticket encodes
them. The other three metrics (cache savings, avg cost / run, per-tool token
attribution) had no real fork and are recorded in the `CONTEXT.md` glossary only.

Two of these mirror the reference project `AeternaLabsHQ/claude-code-stats`
(`aggregate.py`) on purpose: matching its cache-efficiency denominator keeps
Harmonic's cache hit rate directly comparable to a tool people already read. The
reference is a static subscription-model transcript parser; we borrow its metric
shapes, not its architecture (Harmonic is a live server pricing API-equivalent
Cost, see ADR-0009 / ADR-0010).

## Decision

- Cache hit rate's denominator includes cache-write. The rate is
  `read / (input + read + write)`, cache-read tokens over all input-side
  tokens, fresh input plus cache-read plus cache-write. Priming the cache counts
  against the rate until it pays back.
- Active-execution duration is the `agent-finish` run_fact timestamp minus the
  Run's start, and stops there. It excludes the review-park wait and the
  landing wait that follow agent-finish. It measures the agent's own working
  time, not calendar time through the Phase pipeline. When a Run has no
  agent-finish fact (it errored or predates run_facts) it falls back to
  wall-clock `finished − started`; the metric is reported as p50 / p95 so a few
  fallbacks don't distort the headline.
- Failure rate is failed-only: `failed / total` Runs. Cancelled Runs and
  review-rejected Runs are counted and shown separately in the run-states
  breakdown, never folded into the numerator. "Failed-only" excludes rejected
  even though a rejected Run settles to RunState `failed`: a review rejection
  writes `state:'failed'` and `review:'rejected'` together (`reject()` in
  `src/domain/review.ts`), so a naive `runsByState.failed / total` would silently
  count rejections as execution failures. The numerator must exclude Runs whose
  `review` is `rejected`.

## Considered options

- Cache hit rate as `read / (input + read)`, excluding cache-write (rejected).
  The more flattering "of the tokens that could hit, how many did" framing. We
  rejected it because cache-write is real spend, and a rate that ignores it hides
  the cost of priming a cache that is never reused, dishonest by the
  honest-numbers rule (PRODUCT.md). Excluding write would also diverge from the
  reference project, forfeiting the comparability that motivated matching it.
- Active-execution duration as wall-clock `finished − started` (rejected).
  Simpler and always available, but it folds in time a Run sat parked in
  `phase:'review'` awaiting a human gate and time it waited to land, arbitrary
  human/queue latency that is not the agent working. That answers "how long was
  this Run alive," not "how long did the agent work," which is the question the
  metric exists for. Wall-clock survives only as the fallback when no agent-finish
  fact exists.
- Failure rate that folds in cancelled and/or rejected (rejected). A broader
  "didn't-complete rate." Cancelled is deliberate operator abandonment and
  rejected is a reviewer's judgment call; neither is an execution failure.
  Folding them inflates the rate and destroys its value as a reliability signal.
  Keeping them as separate slices in the run-states breakdown means nothing is
  hidden: the rate stays honest and the whole picture stays visible. This one is
  the easy trap to fall into, not just a hypothetical: because a rejection already
  settles the Run to RunState `failed`, doing nothing (filtering by state alone)
  is the fold-in. The failed-only rate takes active work to keep honest.

## Consequences

- The KPI-band ticket and the stats route encode these three formulas exactly;
  this ADR is the reference they cite, not a suggestion.
- Cache hit rate reads lower than an exclude-write formula would. That is the
  accepted honesty cost, and it buys direct comparability with
  `claude-code-stats`.
- Active-execution duration depends on the `agent-finish` run_fact being present.
  Runs that died early or predate run_facts use the wall-clock fallback; because
  the metric is reported as p50 / p95, a minority of fallbacks does not move the
  headline.
- Failure rate cannot be eyeballed as `100% − success%`: cancelled and rejected
  live outside it. The run-states breakdown is where the three reconcile, and it
  must always be shown alongside the rate.
