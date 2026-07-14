# Usage & statistics

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Cost visibility. Each Run collects Usage — input/output/cache token counts
per model and tool-call tallies — via a per-Harness UsageCollector that
reads ACP `_meta`/extension fields first and falls back to parsing the
Harness's native session log on disk (per ADR-0001; shape the collectors
using the spike findings from issue 01). Usage shows on the Run and rolls
up per Task across its Runs.

A stats page aggregates Usage across time ranges, so spend and tool
patterns are visible at a glance.

## Acceptance criteria

- [x] A finished Run shows its Usage: token counts per model and tool-call tallies
- [x] Usage comes from ACP metadata when emitted, session-log parsing when not, and shows as unavailable rather than zero when neither exists
- [x] A Task aggregates Usage across all its Runs, including retries
- [x] The stats page aggregates Usage over selectable time ranges
- [x] Tests drive the stub harness emitting usage metadata over ACP and assert collection, aggregation, and the fallback path

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`

## Comments

**2026-07-14 (agent):** Done. `collectUsage` (src/execution/usage.ts):
aggregate tokens from the ACP prompt result first, per-model breakdown by
parsing the harness's native session log (`<sessionLogDir>/<slug(cwd)>/
<sessionId>.jsonl`, deduped on message id — shaped by the issue-01 spike;
`sessionLogDir` is per-harness config, defaulting to ~/.claude/projects
for Claude). Tool-call tallies come from persisted run events. Usage is
null — unavailable, not zero — when no source reports tokens; collected
best-effort on failed runs too. `GET /api/tasks/:id/usage` rolls up
across runs; `GET /api/stats?from&to` aggregates a time range with
runs-by-state counts. UI: run token counts in the detail view and a Stats
page with range picker, tiles, per-model and tool tables.
