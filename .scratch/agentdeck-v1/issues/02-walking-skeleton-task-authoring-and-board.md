# Walking skeleton: author a Task, see it on the board

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

The end-to-end skeleton of AgentDeck: a single Node/TypeScript process
(Fastify HTTP API, Drizzle on better-sqlite3, embedded React/Vite/Tailwind
SPA) runnable as `npx agentdeck serve`, with Task authoring as the first
vertical slice through it.

An operator can create a Task with a prompt and full execution settings —
Harness (Claude/Codex/Copilot), model (picked from a configured list or
free-text), Working Directory, Isolation Mode (direct/worktree), and
Priority (high/normal/low) — with each setting defaulting from global
configuration so a routine Task needs only a prompt. Tasks can be saved as
draft, moved to ready, edited while draft or ready, and cancelled. The home
screen is a kanban board with a column per lifecycle state; at this stage
only draft, ready, and cancelled are populated, but all columns exist.

No execution happens in this slice — the lifecycle stops at ready. Settings
like Isolation Mode are stored and displayed but only take effect in later
slices.

This slice also establishes the house test style per the PRD's Testing
Decisions: behavior is asserted through the REST API against a real SQLite
database in a temp file. The API is the contract; UI tests stay thin.

## Acceptance criteria

- [ ] `npx agentdeck serve` starts the process and serves both the API and the SPA
- [ ] A Task can be created via UI and REST with prompt plus Harness, model, Working Directory, Isolation Mode, and Priority
- [ ] Every execution setting defaults from global configuration; a prompt alone is enough to create a Task
- [ ] Model accepts either an entry from the configured per-Harness list or a free-text model ID
- [ ] Tasks can be saved as draft, promoted to ready, edited while draft or ready, and cancelled
- [ ] The kanban board shows a column per lifecycle state and reflects Task state without manual refresh gymnastics
- [ ] REST-seam tests cover create/edit/draft/ready/cancel against a real temp-file SQLite database

## Blocked by

None - can start immediately
