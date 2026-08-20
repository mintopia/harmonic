# Stats page redesign — locked design

**Goal:** bring the *metrics & visual richness* of `AeternaLabsHQ/claude-code-stats` into Harmonic's live Stats page — **not** its architecture (it's a static transcript-parser built around a subscription model; Harmonic is a live server+DB pricing API-equivalent cost).

**Shape:** one enriched scrolling page (no tabs). Built **on top of** the current uncommitted work (per-agent breakdown, per-model cost, `BarChart` / `CostBars` / `Donut`).

**Purposes served (all four):** cost control · efficiency · reliability · throughput.
**Out of scope:** plan/billing, rate-limit windows, plan recommendation, billing-currency conversion.

---

## Metric definitions (locked — these are the numbers people will trust)

| Metric | Formula | Notes |
|---|---|---|
| **Cache hit rate** | `cacheRead / (input + cacheRead + cacheWrite)` | Matches the reference (`aggregate.py` `_day_cr/_day_in`). Per-day series skips structurally-trivial slices. |
| **Cache savings** (bonus) | `cacheRead × (inputPrice − cacheReadPrice)` | "What caching saved" delta; reference shows it beside the cost KPI. |
| **Failure rate** | `failed / total` | **Failed-only.** `cancelled` and review-`rejected` shown separately in the run-states donut, never folded into the rate. |
| **Active-execution duration** | `agentFinishTs − startedAt` | Excludes review-park + landing wait. `agent-finish/unresolved` is a timestamped `run_fact`. Fallback `finishedAt − startedAt` when no agent-finish fact. Report **p50 / p95**. |
| **Avg cost / run** | `totalCost / runCount` | Honest floor when any run is unpriceable (`incomplete`). |
| **Per-tool token attribution** | per turn, split output-tokens+cost across the turn's `tool_use` blocks by count-share; no-tool turns → **reasoning** bucket; last entry absorbs rounding remainder | Exactly the reference's `attribute_turn_tokens`. |

---

## Backend (`src/execution`, `src/server`)

1. **Per-tool token attribution** — new work, mirrors the just-added `agents` field:
   - Compute at usage-collection time (turn boundaries + per-turn output tokens exist in the session log).
   - Persist new `toolTokens: Record<tool, {outputTokens, cost?}>` + `reasoning` on `RunUsage`.
   - Aggregate in `mergeUsage`; surface in the stats route + schema.
2. **Token/day series** — today the series is cost/day only; add tokens/day (input+output) so the chart's Tokens toggle has data. Cumulative is derived client-side from the daily series.
3. **Duration + reliability** — from existing data (no new instrumentation):
   - Join `run_facts` for `agent-finish` ts → per-run active duration → p50/p95.
   - `fails/day` + failures by `reason` / `run_fact` type from `runs.reason` + `run_facts`.
   - Failure count / rate derivable from `runsByState` (already present).
4. Everything keeps the house **honest-numbers** discipline (floors, `incomplete`, `—` not fake-zero).

## Frontend (`web/src/components/StatsPage.tsx` + new charts) — top→bottom

1. Range toggle + **hero cost** *(existing)*.
2. **Expanded KPI band:** runs, tokens in/out *(existing)* **+ cache hit rate, failure rate, avg cost/run, median duration** *(new)*.
3. **Time series:** daily chart with **USD / Tokens / Runs** toggle **+ cumulative curve** beneath *(new; needs a line/area component)*.
4. **Efficiency:** cache hit-rate trend + cache read/write split; subagent share *(existing)*.
5. **Breakdowns:** per-model tokens+cost *(existing)*, per-agent *(existing)*, per-tool **calls** *(existing)* **+ per-tool tokens donut with $ + reasoning bucket** *(new)*.
6. **Reliability:** run-states donut *(existing)* + failure rate + **fails/day** + failures **by reason** + duration **p50/p95** *(new)*.

## Build order & estimate

1. Backend: tool-token attribution + persistence + tests (~½–1 day; mirrors `agents`).
2. Backend: token/day series + duration/reliability aggregation + tests (~½ day).
3. Frontend: KPI band + time-series toggle/cumulative component (~½–1 day).
4. Frontend: tool-token donut + reliability section (~½ day).

**~2 days incl. tests.** Aesthetic stays restrained (Linear/terminal, DESIGN.md Signal Rule — state colours reserved for state).

## Post-sign-off housekeeping
- Record the 6 metric definitions in `CONTEXT.md` (glossary).
- One ADR: "Stats metric definitions" (cache denominator, active-execution duration, failed-only rate) — hard to reverse, surprising, a real trade-off.
