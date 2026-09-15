# Decision: Global scope and path-based routing

Status: accepted
Date: 2026-09-15

Refines: 0011-web-ui-and-api-conventions.md (retires the implicit `?view=`
scheme; changes the Workspace-wide search and `workspaceId`-required list rules
for Global scope), 0024-operations-worktree-control-surface.md and
0026-activity-strictly-read-only-agent-glance.md (both become scope-aware rather
than always instance-wide).
Relates to: 0008-usage-cost-and-stats.md, 0009-instance-workspaces-and-settings.md,
0014-enriched-fleet-stats.md.

## Context

A Harmonic instance already hosts many Workspaces (ADR-0009), but every view is
bound to the one active Workspace picked in the switcher. There is no way to
watch several Workspaces at once — to answer "across everything I run, what needs
me, what is it costing, what is in flight". The operator wants a **Global** view
that aggregates across all Workspaces.

Two page groups already behave differently: Activity (ADR-0026) and Operations
(ADR-0024) are instance-wide today, while Tickets, Timeline and Stats are
Workspace-scoped (`?workspaceId=`). So "global" is not a uniform new surface —
some pages already are global, and some Workspace-scoped pages have no global
form at all (Board, Graph, Conversations, Files).

Routing today is a `?view=<name>` query param with the active Workspace held only
in `localStorage`, not the URL. That cannot express two scopes of the same page,
and it violates the standing rule that the URL is UI state.

## Decision

### 1. Scope is a first-class concept

A view runs in one of two **Scopes**: **Workspace** (the default — each page reads
only the active Workspace) or **Global** (pages aggregate across all Workspaces).
Scope is chosen in the Workspace switcher, where **Global** is a peer entry above
the Workspace rows; the switcher button reads "Global" when active. Scope drives
which navigation rail and which pages are shown. See CONTEXT.md.

### 2. Routing is path-based; scope is implicit in the path

The `?view=` scheme is retired. Views are paths, and scope is carried by the path
shape, not a flag:

- **Global** at the top level: `/` (Dashboard), `/tasks`, `/activity`,
  `/timeline`, `/stats`, `/operations`, `/api`, `/settings`.
- **Workspace** under `/workspace/<numeric-id>/…`: `board` (home),
  `conversations`, `graph`, `activity`, `tasks`, `timeline`, `stats`, `files`,
  `operations`, `settings`, plus deep links such as
  `/workspace/<id>/tasks/<taskId>/attempts/<attemptId>/critic`.

`<id>` is the numeric Workspace DB id (stable across rename). Query strings are
reserved for user-specifiable filters — search `q`, state, sort, pagination — never
for identity or scope. This is a **hard cutover**: no redirect shim for old
`?view=` URLs (no-legacy house rule).

Bare `/` restores the last location from `localStorage`, falling back to the
Dashboard when nothing is stored.

### 3. Two navigation rails

- **Global rail**: Dashboard, Tasks, Activity, Timeline, Stats, Operations, API,
  Settings.
- **Workspace rail**: Board, Conversations, Graph, Activity, Tasks, Timeline,
  Stats, Files, Operations, Settings.

API leaves the Workspace rail (it is instance-level and lives in Global only). The
header Settings icon is dropped — Settings is a rail item in both scopes (Global
rail → global settings; Workspace rail → the per-Workspace settings form).

Switching scope maps by page: choosing Global lands on the Global form of the
current page if one exists, else the Dashboard; returning to a Workspace lands on
that page's Workspace form if one exists, else the Workspace's Board.

### 4. Page semantics follow scope

- **Activity and Operations** become **Workspace-filtered in Workspace scope** and
  all-Workspaces in Global scope (a change from their always-instance-wide
  behaviour in ADR-0024/0026).
- **Tickets, Timeline, Stats** aggregate across all Workspaces in Global scope.
- List/query endpoints treat an **absent `workspaceId` as "all Workspaces"**;
  passing one scopes to it. Global search is **instance-wide** (superseding
  ADR-0011's Workspace-wide search for Global scope).
- Global-scope lists carry a **Workspace badge** (first initial + Workspace
  Color) so rows from different Workspaces are distinguishable, kept in one flat,
  time-ordered list rather than grouped, to preserve cross-Workspace ordering.
- **Global Stats** shows instance totals (headline Cost and I/O — never a
  total-token headline, per ADR-0008) plus per-Workspace breakdowns and
  stacked-by-Workspace graphs, so Workspaces can be seen and compared against
  overall usage.

### 5. Workspace Color

Each Workspace is assigned a contrast-safe **Workspace Color** (auto-picked from a
curated palette at creation, editable in Workspace Settings, best-effort unique).
Colors are held to the ADR-0011 contrast gate for both themes. The color plus the
Workspace's first initial forms the badge used in the switcher and every
Global-scope list.

### 6. Dashboard is a reserved placeholder

The Global-scope Dashboard route exists as a placeholder in this work; its visual
design is produced separately (a `/handoff` running `/impeccable` + `/design` to a
single mockup artifact) and is out of scope here.

> **Update (epic #594).** The Dashboard has since shipped fully-built —
> `web/src/components/GlobalDashboard.tsx`: attention/in-flight/cost rollups and a
> cost-ranked Workspace table, following the separately-produced mockup. The
> "reserved placeholder" and "Deferred" framing below describe the state at the
> time of this ADR only.

## Consequences

- **Large routing refactor.** `router-model.ts` (`parseRoute`/`serializeRoute`)
  and every URL builder/link move from `?view=` to paths. Bookmarked `?view=`
  URLs break by design.
- **Endpoint contract change.** Tickets/Stats/Timeline endpoints must accept an
  absent `workspaceId` (all Workspaces) and return Workspace identity per row;
  Activity/Operations gain a Workspace filter. Search scope widens to
  instance-wide in Global.
- **Schema addition.** Workspaces gain a color field (via boot baseline
  convergence, not a migration — ADR-0009 house rule) and a Settings control.
- **Refinements, not reversals.** ADR-0024 and ADR-0026 keep their surfaces and
  read-only/control semantics; only their scoping becomes Scope-driven.
- **Deferred.** The Dashboard's content and layout are not decided here.

## Supersedes

None. Refines 0011, 0024, 0026 as noted above.
