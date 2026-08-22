# Decision: libsql local queries run inline on the main thread — move heavy reads off-thread

Status: accepted
Date: 2026-08-21

## Context

ADR-0029 replaced the synchronous better-sqlite3 connection with async libsql and
claimed (§5) a general guarantee that "**nothing — slow query or background loop —
can block the event loop**," delivered in part by "**routing heavy aggregates
through the async/off-thread path**" (the #213 concurrent read connection,
`asyncReadDb`). This decision is implemented by the Stats worker-thread reader.

Measured reality (2026-08-21): `@libsql/client` (v0.17.4, native `linux-x64`
binding) on a local `file:` URL executes each query **synchronously inline on the
calling thread** and returns an already-resolved Promise. A purely CPU-bound
query that took 1014 ms blocked the event loop **1004 ms (99%)** against a clean
0 ms idle baseline. `await`ing it does not yield the loop. There are no
`worker_threads` anywhere in `src/`, so the #213 "concurrent read connection"
gives WAL *SQLite-level* concurrency but runs its JS on the **same main thread**.

So ADR-0029 §5's premise — that making DB access async moved query CPU off the
loop — does not hold for the local file client. The async migration did deliver
the single-writer queue, per-query wall-clock timeouts, and the
`yieldToEventLoop`/`forEachYielding` helper for JS loops; it did **not** deliver
off-thread query execution. A heavy single query (the Stats aggregate on the
growing DB) will still freeze the loop.

(For context: the board-poll stall that surfaced this — epic #254 — was *not*
this issue; it was an N+1 of many cheap queries plus repricing over 251 tasks.
This ADR is the latent architectural gap, tracked as #257.)

## Decision

- Treat "async libsql" as **not sufficient** for the §5 off-loop guarantee on a
  local file DB. To keep a heavy query off the main event loop, run it on a
  **worker thread**.
- Move the heavy read path — at least the Stats aggregate / the #213
  `asyncReadDb` concurrent-read connection — into a worker thread. libsql in a
  worker blocks that worker's loop, not the main one. The main thread keeps the
  single-writer connection for cheap, bounded queries.
- Keep the other §5 mechanisms unchanged — the single-writer queue, per-query
  wall-clock timeouts, the yield helper for JS loops, and the
  `EventLoopMonitor`. Only the "async = off-thread" assumption is corrected.

## Consequences

- **Amends ADR-0029 §5**: async DB access alone is not off-loop for local
  libsql; the off-loop guarantee for heavy reads is delivered by a worker
  thread, not by awaiting a Promise.
- Worker-thread reads add serialization/IPC overhead and a connection per worker
  (its own WAL read snapshot) — worth it for heavy aggregates, not for the many
  cheap queries that stay on the main connection.
- Cheap per-request queries remain inline and still block briefly; the broader
  cure for a hot endpoint is reducing the number of queries (see #255 filter,
  #258 batch, #256 stored Cost), not worker-threading every read.
- The `EventLoopMonitor` stays the backstop: it will keep reporting any
  remaining heavy inline query as a signal to move it off-thread.

## Supersedes

None (amends ADR-0029 §5).
