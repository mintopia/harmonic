# Decision: Persistence, the database, and event-loop discipline

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md).

## Async libsql, single writer

Harmonic's DB is local SQLite through `@libsql/client` (a `file:` URL) via
`drizzle-orm/libsql`, fully async at the call sites. All writes serialise
through **one single-writer async queue** (one write in flight at a time);
reads run concurrently under WAL. Atomicity is **DB-enforced** — UNIQUE-index
rejection of the loser, transactions as exclusive units within the write queue
— never JS synchrony. Write throughput is one-at-a-time by design: the price
of a predictable single-writer model in a single-instance tool.

The local DB is the source of truth for execution state (ADR-0004 defines the
tracker seam). Configuration is no longer in the DB: it lives in a `settings.yaml`
file in the data directory (ADR-0009, #391), validated on load and dropped-not-
migrated under the clean-break policy below. The DB retains the `settings` table
only for the operator-password credential and small internal markers, not
user-facing configuration.

## The event-loop guarantee

Nothing — a slow query or a background loop — may freeze the whole server.
Local libsql executes each query synchronously **inline on the calling
thread** (an `await` does not yield the loop), so:

- **Heavy reads run on a worker thread** (`stats-reader` / `stats-worker`
  pattern): libsql in a worker blocks that worker, not the main loop. Cheap,
  bounded queries stay on the main connection; the cure for a hot endpoint is
  fewer queries, not worker-threading everything.
- **Loops must yield**: any background loop or heavy in-request scan hands
  the loop back on a wall-clock budget (`forEachYielding` /
  `yieldToEventLoop`) rather than running to completion in one block.
- **Every reconcile or retry loop is bounded** — an iteration budget or a
  minimum re-entry interval, never a tight unbounded spin (git subprocess
  storms have frozen the loop before).
- Per-query wall-clock timeouts bound lock waits; the **EventLoopMonitor**
  probes loop delay and logs a stall as a legible event — it observes, it
  cannot pre-empt, and it is the standing signal that something belongs
  off-thread.

## Migrations

Migrations run with foreign-key enforcement **off at the connection level,
before** `migrate()` (a `PRAGMA` inside drizzle's per-migration transaction is
a no-op), then `foreign_key_check` surfaces any genuine integrity break, then
foreign keys are enabled for runtime. Any table-rebuild migration is safe
under this ordering; runtime writes keep full referential integrity.

**Clean-break policy (owner decision, 2026-08-28)**: Harmonic has one operator
and no external consumers, so there are **no data-compatibility guarantees**
across versions. Migrations may be destructive, may discard stored history
outright rather than re-keying it, and the migration chain may be squashed to
a single baseline schema — on a breaking upgrade the DB is recreated from it.
Anything worth keeping across versions lives in git or the tracker, never only
in the DB; execution history (attempts, usage snapshots, journals) is
disposable by definition. The ordering rule above still governs whatever
migrations do exist.

## The DB stores aggregates, not event streams

The DB does **not** persist the session event stream (the pre-reset
`run_events` firehose ingest measured 375 MB of a 427 MB DB and drove the
event-loop peg). It stores:

- **Tool-call aggregates** per execution (by tool name), dimensioned to Task
  and Epic, computed incrementally in memory and persisted as overwritten
  totals on a coarse cadence.
- **Small structured facts** not recoverable from logs (lifecycle events,
  permission requests).

The output/Activity log is parsed **on demand from the native harness JSONL**,
located via a `transcript_path` persisted at dispatch (resolved, never
reconstructed — cwd slugging is fragile). A missing transcript renders "log
unavailable", never a fabricated log; no tee-to-file, copy-on-dispatch, or
retention machinery exists, because that would re-introduce the persistence
this decision removes. Harnesses that write no native JSONL simply show "log
unavailable".

## Consequences

- The schema after the ADR-0001 implementation epic: `tasks`, `attempts` (the
  single execution ledger), `sessions`, `conversations`/`conversation_events`,
  `task_dependencies`, `tracker_dismissals`, verification attempts, guardrail
  events, the scheduled-jobs registry (ADR-0010), settings, usage/cost
  columns — and none of the coordination tables the frozen-tree model needed
  (no leases, no turn queue, no merge journal, no execution chains).
- Log-format coupling is the accepted cost of parse-on-demand: log shape is
  an integration surface; an unrecognised format fails loudly (flagged
  incomplete), never as a fake zero.
- Historical per-event replay of pre-reset executions is gone; transcripts
  remain readable where their JSONL still exists.

## Absorbed at the reset

Pre-reset 0029 (single-writer queue, DB-enforced atomicity, timeouts,
monitor, yield rule; its "async ⇒ off-loop" claim struck, its lease examples
dead), 0036, 0016 (reworded for libsql), 0031 in full, 0004, 0030's
source-of-truth principle, and the bounded-loop principle distilled from
0024's containment amendment. See README.md for the mapping.
