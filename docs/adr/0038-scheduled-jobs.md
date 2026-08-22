# Decision: Scheduled Jobs — a central Scheduler and a persistent registry for Harmonic's recurring background work

Status: accepted
Date: 2026-08-22

## Context

Harmonic runs a fleet of recurring background mechanisms — the per-Workspace
Tracker poll loop, the Work Context lease sweep, the review-SLA sweep, epic
reconcile, and (newly) a periodic Session-retirement drain and an orphan-worktree
reconcile. Today each owns its own timer (or, worse, has none): the
Session-retirement drain only fires at boot and on `run_changed`
(`app.ts:518,596`), so an idle instance never reclaims lapsed worktrees, and
git-orphaned worktrees with no DB row are never reclaimed at all. There is no
single place that knows a recurring job exists, when it last ran, whether it
succeeded, or when it runs next — so an operator cannot see that the fleet's
own housekeeping is alive and healthy. Sonarr/Radarr solve exactly this with a
"System → Scheduled Tasks" table (name, interval, last run, next run).

ADR-0037 introduces the **Operation** (an OpenTelemetry span) as the "what is
Harmonic doing *right now*" view. That is a live, ephemeral, in-memory surface:
finished Operations survive only in a bounded ring buffer and the OTLP
collector. It is the wrong home for *schedule* state — an hourly job's last-run
would age out of the ring buffer, `interval`/`next-run` are not span data, and
the whole surface resets on restart, which is exactly when an operator checks
whether housekeeping recovered. Schedule state must **outlive** any span.

## Decision

Introduce the **Scheduled Job** as a first-class concept and give it a central
Scheduler plus a small persistent registry, distinct from (and composable with)
the Operation span surface.

- **Scheduled Job ≡ a recurring, Harmonic-scheduled background job that fires on
  a fixed cadence.** Each firing is — once ADR-0037 lands — one **Operation**
  span; the Scheduled Job is the persistent *schedule* that spawns them
  (cron-entry : invocation). (See `CONTEXT.md` → *Scheduled Job*.)

- **One central Scheduler owns every curated Job's interval timer.** It is
  single-flight per Job and yield-aware per ADR-0029 (a Job's tick must not block
  the event loop). It records `last_run_at` / `last_status` / `last_duration_ms`
  / `last_error` on each fire and computes `next_run`. Curated membership uses the
  same "discrete, can-fail, worth-a-name" bar as an Operation: Tracker poll,
  Session-retirement drain, orphan-worktree reconcile, lease sweep, review-SLA
  sweep, epic reconcile, the ADR-0037 metrics summary. High-frequency internal
  ticks (usage tailer, guardrail timers, event-loop probe) are **excluded** —
  mirroring ADR-0037's no-span rule.

- **The Tracker poll is modelled per-Workspace.** It is the one Job with a
  per-Workspace cadence and its own resolution-failure lifecycle, so the
  Scheduler carries **per-Workspace Job instances**, added and removed as
  Workspaces are created and deleted. A Workspace whose Tracker resolution failed
  surfaces as a *disabled* Job, not a fake next-run.

- **Schedule state persists in a small table**, keyed by Job identity
  (`name`, plus `workspace_id` for the per-Workspace poll): `last_run_at`,
  `last_status`, `last_duration_ms`, `last_error`. Interval comes from the
  Scheduler's config, and `next_run` is computed — only the observed last-run
  facts are stored. This is a deliberate, narrow exception to ADR-0031/0037's
  "operation aggregates are in-memory, never persisted": a Scheduled Job's
  last-run is *schedule bookkeeping*, not an Operation aggregate, and it must
  survive the restarts under which the span surface resets.

- **The new drains actually run on a cadence.** The Session-retirement drain
  becomes a real interval Job (~5 min); orphan-worktree reconcile is a new Job
  (~30 min) that reconciles `git worktree list` against the DB and removes
  worktrees no live Session/Run owns. Both intervals are hardcoded constants, not
  operator-configurable — matching ADR-0037's stance that observability plumbing
  stays out of the settings table. (The Tracker poll keeps its existing
  per-Workspace interval setting.)

- **Read-only visibility surface.** A `GET /api/scheduled-jobs` snapshot plus a
  `scheduled-jobs` firehose event feed a read-only **Scheduled Jobs** section on
  the Operations page shell (name · scope · interval · last run · last duration ·
  result · next run · status). No manual "Run now" trigger in v1.

## Consequences

- A new central Scheduler abstraction and a new persistent table (one migration).
  Existing per-mechanism timers are reparented under it — including the
  per-Workspace Tracker poll, which requires the Scheduler to model dynamic
  per-Workspace Job instances tied to Workspace create/delete.
- A narrow, documented divergence from ADR-0031/0037: this schedule state is
  persisted where Operation telemetry is not. The distinction (schedule
  bookkeeping vs. Operation aggregate) is the reason, recorded here so a future
  reader does not read it as a contradiction.
- The Scheduled Jobs surface ships **independently of the ADR-0037 OTel
  foundation** — it depends only on the Operations page *shell*, not on spans —
  and later composes with it: a Job row can link to its firing's Operation span
  once that lands.
- Turning the Session-retirement drain into a real interval Job changes reclaim
  timing (worktrees now clear on an idle instance); orphan reconcile shells out
  to git, so its cadence is deliberately slow to avoid the git-subprocess load
  that has frozen the event loop before.

## Supersedes

None. Relates to ADR-0037 (a Scheduled Job's firing is an Operation span; this
adds the persistent *schedule* the span surface deliberately omits), ADR-0031
(narrow persistence exception, above), and ADR-0029 (the Scheduler's ticks obey
the loops-must-yield rule).
