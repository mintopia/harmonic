# Live, persisted Usage with Subagent roll-up

Usage is parsed continuously while a Run or Conversation executes, not once at
the end. A per-session tailer reads the native logs, coalesces to ~1s, and
emits a `run_usage` firehose event carrying the current snapshot (tokens,
context fill, derived Cost, current-activity line, Process Tree). The parent's
Usage rolls up every Subagent session in its tree. The latest snapshot is
persisted as a single overwritten value on the Run row on a coarser cadence
(~10s, and always on finish); Cost stays derived, never stored.

This supersedes the prior invariant "Usage is stored once at run end." It
exists to power the Activity view's realtime visibility and to make Cost honest
by including Subagent spend.

## Considered options

- **Ephemeral live snapshot (rejected).** Simplest — in-memory only, rebuilt
  from logs on read. Rejected: the operator wanted the current numbers to
  survive a restart and appear without re-deriving.
- **Persist a time-series of samples (rejected).** Enables a context-growth
  curve but writes N rows per Run. The headline need is the *current* value; a
  historical curve is a separate feature with its own ticket.
- **Single overwritten snapshot, coarse cadence (chosen).** Survives restart,
  no write amplification, feeds board/stats/Cost unchanged.

## Consequences

- The Run row gains a live-usage snapshot column; push cadence (~1s) and
  persist cadence (~10s) are deliberately decoupled — smooth UI, lazy DB.
- A new `run_usage` firehose event; included in the read/viz-key filter for
  Runs, excluded for Conversations (matching the existing rule that Conversation
  traffic is hidden from Read Keys).
- Cost at the Run/Task level now includes Subagent tokens; aggregates shift
  accordingly (see ADR 0009 on repricing history).
- Restart loses only the in-flight snapshot, which the tailer rebuilds on the
  next read.
