# Usage & statistics

Status: ready-for-agent

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

- [ ] A finished Run shows its Usage: token counts per model and tool-call tallies
- [ ] Usage comes from ACP metadata when emitted, session-log parsing when not, and shows as unavailable rather than zero when neither exists
- [ ] A Task aggregates Usage across all its Runs, including retries
- [ ] The stats page aggregates Usage over selectable time ranges
- [ ] Tests drive the stub harness emitting usage metadata over ACP and assert collection, aggregation, and the fallback path

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`
