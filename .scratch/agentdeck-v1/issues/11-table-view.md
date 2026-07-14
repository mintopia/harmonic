# Table view

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Bulk housekeeping. Alongside the kanban board, a table view of all Tasks —
filterable (at minimum by lifecycle state, Harness, and Priority) and
sortable (at minimum by creation time and Priority) — so an operator can
scan and tidy many Tasks without clicking through cards.

## Acceptance criteria

- [ ] A table view lists Tasks with their key fields (state, Harness, model, Priority, created)
- [ ] Filters narrow by state, Harness, and Priority; sorts work on creation time and Priority
- [ ] Filtering and sorting are backed by the REST API, not client-side only, and are covered by REST-seam tests

## Blocked by

- `02-walking-skeleton-task-authoring-and-board.md`
