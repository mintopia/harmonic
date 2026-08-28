# Decision: Usage, Cost, and Stats metrics

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md). Target-state note: metric
code still reads pre-reset Run tables until the ADR-0001 epic re-keys them to
Attempts.

## Usage comes from native session logs

Usage and the Process Tree are produced by parsing each harness's **own
native session logs**, not ACP result metadata and not OTel: Claude jsonl plus
per-Subagent `subagents/agent-*.jsonl` (joined via the `.meta.json` sidecar's
`toolUseId`), Codex jsonl, Copilot `events.jsonl` plus its
`session-store.db` (per-turn tokens, AI Units, Subagent attribution). The
per-harness Usage Collector owns this parsing. Log shape is an integration
surface: an unrecognised format **fails loudly** — flagged incomplete, never a
fake zero. Codex has no Subagent concept; its Process Tree is a single node.

## Live, persisted Usage with Subagent roll-up

Usage is parsed continuously while an Attempt or Conversation executes: a
per-session tailer coalesces to ~1s and emits a `run_usage` firehose event
(tokens, context fill, derived live Cost, current activity, Process Tree).
The parent rolls up every Subagent in its tree. The latest snapshot persists
as a **single overwritten value** on a ~10s cadence and always on finish —
kept as-is by owner decision: it survives restart with no write
amplification. Conversation traffic stays out of read/viz keys.

## Cost is computed once and stored

A settled execution's Cost is a historical fact: computed once at settle from
its frozen Usage against the price table then in effect, and stored. A later
price-table edit never silently reprices history — an intentional reprice is
an explicit backfill. Read paths return the stored value (a Task's Cost sums
its Attempts' stored Costs); live in-flight Cost may still derive from the
current snapshot. A model without a configured price yields no Cost, and any
aggregate containing it is flagged incomplete — never a fake zero.
Harness-native spend units (Copilot AI Units) are recorded alongside, never
folded into Cost.

## The three locked Stats formulas

Stats numbers get trusted and compared across ranges; changing a formula
silently reprices history, so the three contested ones are locked here:

1. **Cache hit rate** = `read / (input + read + write)` — cache-read tokens
   over **all** input-side tokens, cache-write included. Priming a cache that
   is never reused counts against the rate; excluding write would hide real
   spend and break comparability with the `claude-code-stats` reference this
   deliberately matches. The rate reads lower than the flattering formula;
   that is the honesty cost.
2. **Active-execution duration** = **the sum of agent time only** — the time
   agents (builder, critic, conflict-resolve turns) were actually working an
   Attempt. Time not spent with agents never counts: scheduling waits, git
   operations, merge/post-merge checks, and escalated idle time are all
   excluded. Reported p50 / p95; where agent-time facts are missing
   (historical rows), wall-clock start→finish is the recorded fallback, and
   the percentile reporting keeps a minority of fallbacks from moving the
   headline.
3. **Failure rate** = failed Attempts over total Attempts, at Attempt grain:
   a **failed Attempt counts, and a review rejection is a failed Attempt**
   (the loop's uniform outcome — command fail, critic reject, and
   inconclusive all burn an Attempt, ADR-0001). Cancelled work is deliberate
   operator abandonment and stays out of the numerator, shown separately in
   the state breakdown, which is always rendered beside the rate so the
   pieces reconcile.

## Consequences

- The stats route and KPI band encode these formulas exactly; this ADR is
  the reference they cite.
- Fixing an undercount (e.g. newly counted Subagent logs) reprices only
  unsettled work; settled Cost stays frozen unless explicitly backfilled.
- Parsing is coupled to undocumented, moving log formats — the accepted cost,
  paid with loud failure.

## Absorbed at the reset

Pre-reset 0009 in full, 0010 (its never-store-Cost clause superseded by
0035), 0035, 0028 re-based to the Attempt with the duration and
failure-numerator definitions above (owner-decided). See README.md for the
mapping.
