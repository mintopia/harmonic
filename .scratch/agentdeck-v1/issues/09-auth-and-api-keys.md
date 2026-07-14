# Auth & API Keys

Status: ready-for-agent

## Parent

`.scratch/agentdeck-v1/PRD.md` (AgentDeck v1)

## What to build

Lock the instance down. A single operator account whose password is set via
CLI or config on first run, hashed at rest — the instance is never open to
anyone who can merely reach the port. The SPA authenticates with cookie
sessions (login/logout); the REST API authenticates with named, revocable
bearer API Keys. Every existing endpoint comes under the appropriate
scheme.

Operators can create, name, and revoke API Keys from the UI and see each
key's last-used time, so programmatic access is manageable and auditable.
This slice provides the key infrastructure the MCP slice later builds on
(per-Run scoped keys).

## Acceptance criteria

- [ ] First-run setup requires setting the operator password via CLI or config; the password is hashed at rest
- [ ] The SPA requires login and uses cookie sessions; logout works
- [ ] All REST endpoints reject unauthenticated requests; bearer API Keys authenticate the API
- [ ] API Keys can be created with a name, listed with last-used timestamps, and revoked; revoked keys stop working immediately
- [ ] REST-seam tests cover login, session-gated UI API, key auth, revocation, and last-used tracking

## Blocked by

- `02-walking-skeleton-task-authoring-and-board.md`
