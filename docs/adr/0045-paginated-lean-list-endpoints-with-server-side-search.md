# Decision: List endpoints are lean, paginated, and searched server-side; full detail lives on the item GET

Status: accepted
Date: 2026-08-26

## Context

The Board became very slow. `GET /api/tasks` returns **every** task in the
Workspace with no pagination — 340 tasks in the live instance, 328 of them
terminal (`done`/`cancelled`) — and each row carries its **full `prompt`**. Full
prompts were 461 KB of an ~800 KB response (58%); the Board only renders a
first-line title (`cardTitle`) from it. The browser re-parses and re-processes
the whole payload on every load and Workspace switch. Transport is fast
(localhost 1–97 ms, relay ≤120 ms) — the cost is payload size and client work.

The obvious fix — have the Board request `state=open` — is unsafe today because
the single `/api/tasks` response is shared by three surfaces that each lean on
data the Board itself does not render:

- **Table search** (`filterBySearch`, issue #104) substring-matches the **full
  prompt** client-side, so it needs every task and the full prompt in the browser.
- **The Ticket modal** reads its task (including the full-prompt description) out
  of the **list array**, not a single-resource fetch.
- **The Graph view** keeps terminal tasks that still block an open task, and has
  a "Show terminal tasks" toggle — so it needs the terminal rows the Board hides.

So the weight has to move server-side and the surfaces decoupled, rather than
narrowing one shared over-fetch. A `view=board` mode on `/api/tasks` was
considered and rejected: branching a list endpoint's shape on a mode flag makes
the API harder to reason about. The API should stay straightforward and uniform.

## Decision

**List endpoints return a lean, paginated, server-filtered, server-searched page.
Full detail lives on the single-resource GET.** Applied consistently to every
list endpoint, `/api/tasks` first.

1. **Lean rows.** `GET /api/tasks` list rows **omit the full `prompt`** and carry
   a server-derived `summary` (first line, bounded length) instead. The full
   `prompt` is served only by `GET /api/tasks/:id`.
2. **Pagination.** Every list endpoint accepts `limit` and `offset` (bounded
   default and max `limit`) and returns the page plus a `total` count. One shared
   contract and helper — not per-endpoint bespoke shapes — across `/api/tasks`,
   `/api/epics`, `/api/maps`, conversations, and the rest.
3. **Filters as plain query params.** `state` (including the `open` pseudo-state
   that excludes terminal tasks) and the existing `harness`/`priority`/sort
   params stay flat query params. No mode/`view` params.
4. **Server-side search.** A `q` param filters on the server (matched against the
   full prompt and title); the client stops shipping-and-scanning the whole
   corpus. `filterBySearch` is retired.
5. **Consumers decoupled to match:**
   - **Board** fetches `state=open` + pagination; renders from `summary`.
   - **Ticket modal** fetches `GET /api/tasks/:id` for the open task instead of
     reading it from the list array.
   - **Board dependency chips** derive "satisfied" from the server-authoritative
     `openBlockerCount` / `blockedOnFailed` (already computed over the full DB in
     `listWithDeps`) rather than looking the blocker task up in the returned page.
   - **Graph view** fetches its whole-graph data explicitly (lazily, when the
     Graph tab opens), independent of the Board's paginated page.

## Consequences

- The Board payload drops from ~800 KB/340 rows to a small page of lean rows;
  first paint and Workspace switches get materially faster. This is the fix for
  the reported slowness.
- Blocked-ness and epic-frontier correctness are unaffected: both are already
  server-derived (`openBlockerCount`/`blockedOnFailed` in `listWithDeps`; the
  epic read model's `reduceMemberState`), not recomputed from the returned list.
- Search moves server-side — behaviour parity with issue #104 must be verified
  (case-insensitive substring over prompt + title), and search now spans the
  whole Workspace, not just the fetched page (an improvement, but a change).
- The generated OpenAPI (`website/src/openapi.json`, ADR-0005) and the frozen
  Epic DTO contract touch points must be updated from the zod source of truth;
  the `tasksListResponseSchema` grows a `total`/pagination envelope.
- Every list-endpoint consumer in the web client must handle paging (the Table's
  client-side `paginate()` / `TABLE_PAGE_SIZE` is replaced by server paging).
- A one-time sweep is needed to bring the remaining list endpoints onto the
  shared contract; until an endpoint is migrated it keeps returning everything,
  so the rollout is sequenced endpoint-by-endpoint with behaviour green
  throughout.

## Supersedes

None. Builds on 0005 (OpenAPI from zod), 0008 (Workspaces), 0015 (graph view),
0024/0026 (Epic read model); supersedes none of them.
