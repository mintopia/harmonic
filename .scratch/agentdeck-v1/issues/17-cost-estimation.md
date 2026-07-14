# Cost: dollar values on Runs, Tasks, and statistics

Status: done

## Parent

QA session (2026-07-14)

## What to build

Cost (see CONTEXT.md): the API-equivalent dollar value of Usage — token
counts priced per model. Displayed plainly as "Cost" (no "estimated"
qualifier), always derived from stored Usage on demand, never persisted.

Pricing:

- A shipped default price table covering the models the supported
  Harnesses actually use (Claude family, GPT/Codex family), with four
  rates per model in $/Mtok: input, output, cache-read, cache-write —
  matching the four counters `RunUsage.models` already stores.
- Config can override any default and add new models; the price table
  rides the existing config-repo export/import.
- A model with no price entry yields no Cost, and any aggregate
  containing an unpriced model is flagged incomplete — never a fake
  zero (consistent with the existing Usage philosophy).

Semantics:

- Run Cost: its per-model Usage × prices, summed.
- Task Cost: the sum of ALL its Runs, retries and failed attempts
  included — waste caused by a Task is part of its Cost.
- Compute on read everywhere: one consistent price table across all
  history; fixing a price retroactively corrects everything.

Surfaces:

- Run detail: Cost alongside Usage, with the per-model split.
- Task detail: total Cost across all Runs.
- Table view: sortable Cost column (computed server-side, since
  sorting/filtering is API-backed).
- Stats page: total Cost for the period plus Cost per model alongside
  the existing token breakdown.
- Board cards: intentionally no Cost — cards are state-at-a-glance.

## Acceptance criteria

- [x] Default price table ships with rates for the common Claude and GPT/Codex models; config can override and extend it
- [x] Run detail shows Cost with per-model breakdown
- [x] Task detail shows total Cost summed over all Runs including failed/rejected attempts
- [x] Table view has a Cost column, sortable via the API
- [x] Stats page shows period total Cost and per-model Cost
- [x] Runs on unpriced models show no Cost; aggregates containing them are flagged incomplete, not zero
- [x] Changing a configured price changes displayed Cost for historical Runs (nothing persisted)
- [x] Tests cover pricing math (all four token classes), the unpriced-model path, and task-level summation

## Blocked by

None (backend); UI surfaces land before `18-design-audit-and-polish.md`.
