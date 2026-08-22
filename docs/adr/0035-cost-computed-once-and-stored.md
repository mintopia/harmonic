# Decision: Cost is computed once and stored, frozen at the incurred price

Status: proposed
Date: 2026-08-21

## Context

ADR-0010 set the invariant "Cost stays derived, never stored," and ADR-0009
accepted that fixing usage undercounts "reprices history the moment logs are
re-read." Today Cost is recomputed on every read from a Run's stored Usage
against the live price table (`src/server/serialize.ts` `costOfUsages`,
`pricesOf`).

Two problems follow.

- Semantics. A settled Run's Cost is a historical fact: what it actually
  cost at the time it ran. A later edit to the price table should not silently
  rewrite past spend. Once a Run finishes, its tokens are frozen, so its Cost is
  fixed. The only reason it moves today is that reads reprice it against
  whatever prices are current.
- Performance. Deriving Cost per read forces the read path to load every
  Task's Runs and reprice them. This is a large share of the `/api/tasks` N+1
  that stalls the board poll (epic #254; measured about 326 ms/poll over 251 tasks,
  tripping the event-loop monitor). See #256 (this decision) and #258 (batch
  the remaining reads).

Tokens are immutable once a Run settles; the only input that can change is the
price table, and we have decided a price change must not retroactively alter
historical Cost.

## Decision

- Compute a Run's Cost once, at settle, from its frozen Usage and the price
  table then in effect, and persist it on the Run row (a stored Cost value).
- Historical Cost is frozen. A later price-table change does not reprice
  settled Runs. A price change applies to Runs settled after it, plus an
  explicit, deliberate recalculation/backfill where an operator intends one,
  never implicitly on read.
- Read paths (the board list, Stats, Task Cost = sum of its Runs' stored Costs)
  return the stored value; no price resolution on read.
- Live / in-flight Cost (ADR-0010's `run_usage` snapshot, while tokens are
  still changing) may still be derived from the current snapshot. Freezing
  applies at settle, not before.

## Consequences

- Amends ADR-0010 ("Cost stays derived, never stored") and ADR-0009
  ("fixing the undercount reprices history"): for settled Runs, Cost is stored
  and does not reprice. ADR-0010's live-usage snapshot mechanism is otherwise
  unchanged.
- The `/api/tasks` and Stats read paths no longer reprice per read, removing a
  large share of the board-poll stall (pairs with #258's batch loading).
- Schema migration: a Cost column on `runs`, written at settle, with a one-time
  backfill of existing settled Runs against the current price table (the
  accepted one-time reprice).
- A price-table edit no longer instantly re-values dashboards and history;
  intentional repricing needs an explicit action. That is the point.
- Trade-off: correcting a genuinely wrong past price now needs a deliberate
  backfill instead of happening automatically on the next read.

## Supersedes

None (amends ADR-0009 and ADR-0010 for settled Runs, as described above).
