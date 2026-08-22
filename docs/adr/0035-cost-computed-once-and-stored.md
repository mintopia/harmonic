# Decision: Cost is computed once and stored, frozen at the incurred price

Status: proposed
Date: 2026-08-21

## Context

ADR-0010 set the invariant "Cost stays derived, never stored," and ADR-0009
accepted that fixing usage undercounts "reprices history the moment logs are
re-read." Today Cost is recomputed on every read from a Run's stored Usage
against the live price table.

Two problems follow.

- A settled Run's Cost is a historical fact. A later price-table edit should
  not silently rewrite past spend.
- Deriving Cost per read forces the board and Stats to load and reprice Runs.

## Decision

- Compute a Run's Cost once, at settle, from its frozen Usage and the price
  table then in effect. Persist it on the Run row.
- Historical Cost is frozen. A price change applies to later Runs and an
  explicit backfill only, never implicitly on read.
- The board, Stats, and Task Cost read stored values. Task Cost sums its Runs'
  stored Costs.
- Live in-flight Cost may remain derived from the current usage snapshot.

## Consequences

- This amends ADR-0010 and ADR-0009 for settled Runs.
- The migration adds `runs.cost` and performs a one-time backfill of existing
  Runs against the current price table.
- Correcting a past price needs a deliberate backfill.
