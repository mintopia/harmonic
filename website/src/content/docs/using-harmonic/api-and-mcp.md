---
title: API & MCP
description: How Harmonic's REST API, MCP server, and API-key scopes work, and where the generated OpenAPI reference lives.
---

Harmonic exposes two machine surfaces from the same server: a **REST API**
under `/api`, and a **MCP server** at `/mcp` for the harnesses it spawns.
Both share one auth model built on bearer tokens.

## REST API

Every route lives under the base path **`/api`**, organized as Fastify route
modules — one module per resource group, roughly matching the OpenAPI tags
below.

Per [ADR 0005](/harmonic/how-it-works/design-decisions/), the OpenAPI 3.1
spec is **generated at runtime from the zod schemas** attached to every
route, via `fastify-type-provider-zod` and `@fastify/swagger` — it is never
hand-written. A route without a zod schema is a defect: it ships
undocumented and unvalidated, so new routes must declare their schemas.

| Group | Covers |
| --- | --- |
| Tasks / Runs | Task CRUD, queue, cancel, accept/reject; run listing and run events |
| Workspaces | Workspace CRUD and settings |
| Conversations | Interactive sessions; Permission Rules |
| Config | Global configuration |
| Auth / Keys | Login/logout/password; API-key create/list/revoke |
| Channels | Notification Channels |
| Activity / Stats | Activity feed and usage stats |
| Maps | Wayfinder maps |
| Filesystem | Directory browsing |

The spec documents the whole `/api` surface — including auth, keys, and
config — with run-scoped-key restrictions noted per endpoint. The MCP server
and the WebSocket are described in prose only, inside the spec's
`description`; they are not modeled as OpenAPI paths.

## The generated API reference

The spec is served live by a running Harmonic instance at `GET
/api/openapi.json` and `GET /api/openapi.yaml`. Both are deliberately
**unauthenticated** — part of `PUBLIC_API_PATHS` — since an open-source
project's API surface is already public.

The web UI renders that spec on its **API page**, via a hand-rolled
reference component (not Swagger UI or Scalar). The API page also surfaces
connection info — base URL, the MCP endpoint, a `curl` example, download
links for the JSON/YAML spec — and the API-key management UI.

Because the reference is generated straight from the zod route schemas
(ADR 0005), it can never drift out of sync with the code — read it as the
authoritative, always-current description of `/api`.

A browsable copy of this same spec is also published on this docs site at
[API reference](/harmonic/reference/api/).

## MCP server

Harmonic runs its own **MCP server** (`@modelcontextprotocol/sdk`), exposed
to the harnesses it spawns — see [Architecture](/harmonic/how-it-works/architecture/)
for where it sits in the system. It's a **stateless streamable-HTTP**
server mounted at **`POST /mcp`**; a fresh server instance is built per
request, so the registered tool list always reflects current config.

It authenticates the same way as REST: a bearer token, either an operator
API key or the **Run Key** Harmonic injects into a spawned harness. Harmonic
computes and injects the `/mcp` endpoint URL into each harness it spawns.

| Tool | Purpose |
| --- | --- |
| `create_task`, `list_tasks`, `get_task`, `update_task` | Task CRUD |
| `queue_task`, `cancel_task` | Queue / cancel a Task |
| `add_dependency`, `remove_dependency` | Task dependency edges |
| `get_runs`, `get_run_events` | Read-only access to Runs and Run Events |
| `finish_task`, `escalate_task` | Signal an afk Run resolved / escalate to a human |
| `accept_task`, `reject_task` | The review gate — only registered when the global `agentReview` flag is enabled (default off) |

Together these give an agent everything it needs to build autonomous
pipelines: task CRUD, dependencies, queue/cancel, and read access to runs.
Accept/Reject — the review gate — stays gated behind the opt-in
`agentReview` flag; by default the review gate stays human, per
[ADR 0002](/harmonic/how-it-works/design-decisions/).

## API keys

Both REST and MCP send bearer tokens as `Authorization: Bearer <token>`.
WebSocket clients can't set headers, so they pass `?token=` instead. A
created token is shown **once** and stored only as a hash — there is no way
to retrieve it again later.

| Scope | What it is | Capabilities |
| --- | --- | --- |
| `full` | Operator **API Key** (`POST /api/keys`, default scope) | Drives the whole fleet — full read/write |
| `read` | A viz-client key (`POST /api/keys` with `{"scope":"read"}`) | GET-only: read tasks, runs, maps, activity, and open the WebSocket; cannot mutate anything |
| `run` | A **Run Key**, minted per Run and injected into the spawned harness | Scoped to tasks/runs + `/mcp`; dies with its Run (swept at boot if orphaned) |
| `conversation` | A **Conversation Key**, minted per Conversation | Machine credential; dies with its Conversation (all swept at boot) |

Only `full` and `read` keys are listed by `GET /api/keys` — `run` and
`conversation` keys are machine credentials and are never listed.
Management endpoints:

| Endpoint | Effect |
| --- | --- |
| `POST /api/keys` | Create a `full` or `read` key |
| `GET /api/keys` | List `full`/`read` keys |
| `DELETE /api/keys/:id` | Revoke a key |

**Ungated mode**: with no operator password set, Harmonic runs
open/unauthenticated by design — a local single-user tool. Setting a
password gates the surface.

## See also

- [Architecture](/harmonic/how-it-works/architecture/)
- [Design decisions](/harmonic/how-it-works/design-decisions/)
- [Settings & overrides](/harmonic/using-harmonic/settings-and-overrides/)
- [Notifications](/harmonic/using-harmonic/notifications/)
- [Tracker mirroring & skills](/harmonic/how-it-works/tracker-mirroring/)
