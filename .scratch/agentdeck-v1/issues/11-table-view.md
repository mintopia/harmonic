# Table view

Status: done

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Bulk housekeeping. Alongside the kanban board, a table view of all Tasks —
filterable (at minimum by lifecycle state, Harness, and Priority) and
sortable (at minimum by creation time and Priority) — so an operator can
scan and tidy many Tasks without clicking through cards.

## Acceptance criteria

- [x] A table view lists Tasks with their key fields (state, Harness, model, Priority, created)
- [x] Filters narrow by state, Harness, and Priority; sorts work on creation time and Priority
- [x] Filtering and sorting are backed by the REST API, not client-side only, and are covered by REST-seam tests

## Blocked by

- `02-walking-skeleton-task-authoring-and-board.md`

## Comments

**2026-07-14 (agent):** Done. `GET /api/tasks` accepts `state`, `harness`,
`priority` filters and `sortBy=createdAt|priority` + `order=asc|desc`
(validated, 400 on junk), implemented in `TaskService.list`. Table view in
the SPA (web/src/components/TableView.tsx) with filter selects and
click-to-sort headers, all delegated to the API; rows open the task
detail. Priority sort ranks high→normal→low with FIFO within a rank.
