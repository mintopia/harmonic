# Decision: The DB holds tool-call aggregates, not the session event stream; the output log is parsed from the native harness JSONL

Status: accepted
Date: 2026-08-21

## Context

Today the runner ingests the full ACP `session/update` firehose into
`run_events` — one row per event, tool results stored verbatim. Measured on the
live instance (2026-08-21): **375 MB of a 427 MB DB is `run_events.payload`**;
`tool_call_update` alone (full `rawOutput` / `toolResponse`, untruncated up to
301 KB each) is **343 MB = 91%**, and it grows unbounded — retired Runs' events
are never pruned (67 retired sessions' transcripts still resident). `better-sqlite3`
writes are synchronous on the main thread, so this ingest plus WAL checkpoints on
a 400 MB+ file is a direct contributor to the recurring event-loop starvation /
CPU peg that takes the server down (see the live incident on this date: main
thread pegged at 94%, every API route timing out, process ultimately dying).

This contradicts two accepted ADRs:

- **ADR-0009** — Usage and the Process Tree are produced by *parsing each
  Harness's own native session logs*, not ACP result metadata. The native log is
  already the source of truth for what happened in a Run.
- **ADR-0010** — explicitly **rejected** "persist a time-series of samples (N rows
  per Run)" as write-amplification, choosing a single overwritten snapshot on the
  Run row. `run_events` is exactly that rejected N-rows-per-Run pattern, widened
  from usage to the entire event stream.

The reason `run_events` persisted the stream at all was to render the Activity /
output log in the UI. But that log already exists on disk: Claude Code writes the
transcript to `~/.claude/projects/<slug(cwd)>/<harness_session_id>.jsonl`, which
lives **outside** the worktree (so it survives Session retirement). Both `cwd` and
`harness_session_id` are already columns on the `sessions` row.

## Decision

1. **The DB does not persist the session event stream.** The `run_events`
   `session_update` firehose is removed.

2. **The DB stores tool-call aggregates only.** Per-Run counts of tool calls (by
   tool name), dimensioned natively to Task and Epic (via the existing
   Run → Task → Epic relations). Computed incrementally in memory from the ACP
   stream and persisted as overwritten totals on a coarse cadence — the same
   snapshot discipline ADR-0010 chose for usage (push ~1s, persist ~10s and on
   finish). Small structured facts not recoverable from the log stay (lifecycle,
   permission requests).

3. **The output / Activity log is parsed on demand from the native harness JSONL**
   (the ADR-0009 collector already parses these formats). The transcript is
   located via a `transcript_path` persisted on the `sessions` row at dispatch —
   resolved, not reconstructed (Claude Code maps both `/` and `.` in the cwd to
   `-`; slug reconstruction is fragile).

4. **A missing transcript is acceptable.** If the JSONL is gone or a Harness never
   wrote one, the UI shows a "log unavailable" message and the user accepts it.
   No tee-to-file, copy-on-dispatch, or retention machinery — that would re-introduce
   the persistence this ADR removes.

## Consequences

- The DB collapses from 400 MB+ to single-digit MB. The synchronous 343 MB write
  path and its WAL churn — a direct cause of the event-loop peg — disappear.
  Session retirement / pruning becomes trivial because nothing large accumulates.
- The log view is coupled to the Harness's native log format and location. This is
  already the accepted cost of ADR-0009 ("treat log shape as an integration
  surface and fail loudly"); the same rule applies here — an unrecognised or
  absent transcript yields "log unavailable", never a fabricated log.
- Non-Claude Harnesses that do not write a native JSONL simply show "log
  unavailable", consistent with point 4. No parallel persistence path is built for
  them.
- The log survives worktree retirement (the transcript is in `~/.claude/projects`)
  but is **not** retained indefinitely or guaranteed — acceptable per point 4.
- Existing `run_events` rows are dropped in a migration; per-event *replay* of
  historical Runs is lost. Aggregates are recomputed going forward; historical
  transcripts remain readable where their JSONL still exists on disk.
- Aggregation must preserve the Task/Epic dimensions natively so Stats and the
  board do not regress (ADR-0028 metric definitions still hold).

## Supersedes

None. Extends ADR-0009 (native session-log parsing) and ADR-0010 (no write
amplification; derive from logs), and removes the undocumented `run_events`
event-stream persistence that violated both.
