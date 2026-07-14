# Auth & API Keys

Status: done

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

- [x] First-run setup requires setting the operator password via CLI or config; the password is hashed at rest
- [x] The SPA requires login and uses cookie sessions; logout works
- [x] All REST endpoints reject unauthenticated requests; bearer API Keys authenticate the API
- [x] API Keys can be created with a name, listed with last-used timestamps, and revoked; revoked keys stop working immediately
- [x] REST-seam tests cover login, session-gated UI API, key auth, revocation, and last-used tracking

## Blocked by

- `02-walking-skeleton-task-authoring-and-board.md`

## Comments

**2026-07-14 (agent):** Done. `AuthService` (src/server/auth.ts): scrypt
password hash in the settings table, in-memory cookie sessions
(httpOnly, SameSite=strict), sha256-hashed bearer keys with prefix
display, last-used tracking, and immediate revocation. A global onRequest
hook gates every /api path (including WebSocket upgrades; token accepted
as a query param for WS clients that can't set headers) except
login/me. CLI: `serve --password` / $AGENTDECK_PASSWORD, refusing first
run without one. Key schema includes scope+runId for the MCP slice's
per-run scoped keys. SPA: login screen, logout, and an API Keys modal
(token shown exactly once). Test helper now logs in like the SPA, so the
whole suite exercises session auth.
