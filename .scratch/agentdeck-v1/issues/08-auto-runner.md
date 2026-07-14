# Auto-Runner

Status: ready-for-agent

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

- [ ] A global toggle enables/disables the Auto-Runner from the UI and REST, and its state is visible at a glance
- [ ] With the Auto-Runner on, ready Tasks start automatically in Priority-then-FIFO order
- [ ] Concurrent Runs never exceed the configured maximum; a slot freeing up pulls the next pick
- [ ] With the Auto-Runner off, nothing starts automatically and manual "run now" still works
- [ ] Tests use the stub harness with delays to prove pick order and max-concurrency enforcement

## Blocked by

- `03-execute-a-run-over-acp-direct-mode.md`
