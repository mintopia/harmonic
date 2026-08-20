# 29. Async DB via libsql with a single-writer queue

Date: 2026-08-20

## Status

Accepted

## Context

Harmonic runs on a single **synchronous** better-sqlite3 connection (`drizzle-orm/better-sqlite3`), shared by every HTTP handler and every background loop (crash-recovery sweep, lease heartbeat/sweep, tracker poll, guardrail poll) on the one Node event loop. There is no off-thread work anywhere.

Because SQLite calls are synchronous and on the event loop, **any** expensive query or any hot/looping operation blocks the entire process: every in-flight and incoming HTTP request stalls until it returns. This is not hypothetical — an unbounded git-retry loop (#199) combined with synchronous DB access froze the whole UI (#200); a large aggregate on the growing DB (~275 MB and climbing) is a latent version of the same failure.

We want a guarantee that **nothing — slow query or background loop — can block the event loop**.

## Decision

1. **Move DB access fully async by swapping the driver to libsql** — `@libsql/client` against a local `file:` database, via `drizzle-orm/libsql`. Every `.get/.all/.run` becomes `await`.
2. **Single-writer async queue; reads concurrent.** All writes serialize through one queue (one write in flight at a time); reads run concurrently under WAL. Call sites are classified read vs write.
3. **Atomicity stays DB-enforced.** The coordination spine's exactly-one-winner guarantees (Work Context lease `acquire`, `run_facts` `seq` monotonicity) come from **UNIQUE-index rejection of the loser** (a single guarded INSERT), not from JS running synchronously — so they survive async unchanged. The 6 existing `.transaction()` sites become async transactions that run as exclusive units within the write queue.
4. **Migrate incrementally, expand-contract, per store/domain module.** Introduce the async `Db` + queue facade alongside the sync one; migrate store by store keeping CI green; flip routes and the runner; delete the sync path last.
5. **#200 owns the general guarantee**, beyond the driver swap: an event-loop watchdog, a rule+helper that background loops chunk and yield, per-query wall-clock timeouts, and routing heavy aggregates through the async/off-thread path.

No validation spike — libsql behavioural compatibility (the FK off/on boot dance + `foreign_key_check`, `.pragma()` usage, WAL semantics, async transactions) is proven in the Expand step and fixed as it surfaces.

## Consequences

- **Async contagion** propagates `await` through every store, route, the runner, and the entire (currently synchronous) vitest suite — this is the bulk of the work (~18–22 tickets, multi-week).
- **libsql is a different engine** from better-sqlite3; without a spike, incompatibilities are absorbed during Expand and the early store batches, which carries schedule risk.
- **Reduced blast-radius risk:** atomicity does not depend on synchrony, and there are only 6 transaction sites, so the coordination spine's correctness is preserved by construction.
- **Write throughput becomes one-at-a-time** by design; acceptable for a single-instance tool and the price of a predictable single-writer model. Reads scale with WAL.
- **Operational prerequisite:** the migration repeatedly exercises the landing path under the auto-runner, so the reliability fixes #198 (landing leaves base detached) and #199 (unbounded git-retry loop) must land first.

## Alternatives considered

- **Worker-thread RPC around better-sqlite3** (keep the engine, async at the boundary): keeps exact SQLite semantics but a bespoke facade; rejected in favour of a first-class async driver + drizzle-async.
- **`node:sqlite`**: still synchronous (`DatabaseSync`); does not solve the problem.
- **Serialize every op through one queue** (no read/write split): simpler, but gives up read concurrency; rejected in favour of concurrent WAL reads.
- **busy_timeout + retry on SQLITE_BUSY** instead of a write queue: reintroduces the contention/retry churn we are trying to eliminate.
