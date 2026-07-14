# Auto-Runner

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Unattended execution. A global Auto-Runner toggle switches between hands-on
and unattended operation. When enabled, the Auto-Runner starts ready Tasks —
highest Priority first, FIFO by creation time within a Priority — up to a
configurable maximum of concurrent Runs (default 1). Manual "run now"
continues to work on any ready Task even when the Auto-Runner is off.

The toggle and current concurrency are visible in the UI so the operator
always knows whether the system is picking up work by itself.

## Acceptance criteria

- [x] A global toggle enables/disables the Auto-Runner from the UI and REST, and its state is visible at a glance
- [x] With the Auto-Runner on, ready Tasks start automatically in Priority-then-FIFO order
- [x] Concurrent Runs never exceed the configured maximum; a slot freeing up pulls the next pick
- [x] With the Auto-Runner off, nothing starts automatically and manual "run now" still works
- [x] Tests use the stub harness with delays to prove pick order and max-concurrency enforcement

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`

## Comments

**2026-07-14 (agent):** Done. `AutoRunner` (src/execution/auto-runner.ts)
fills free slots with ready tasks — priority rank then createdAt then id —
capped by `autoRunner.maxConcurrentRuns` (counted from running run rows so
the cap can't be overshot by spawn latency). Poked on task-ready and
run-finished bus events, on config PATCH, and at boot; coalesced via
setImmediate so it never re-enters. Toggle lives in config
(`PATCH /api/config`), surfaced as a header switch with live running/max
count. Tests use delayed stub scenarios to prove pick order, the cap,
slot-freeing pull, off-mode inertness with manual run-now, and hands-free
pickup of unblocked dependents.
