# Decision: Observability — Operations as OTel spans, and Scheduled Jobs

Status: accepted
Date: 2026-08-28
Part of the 2026-08-28 ADR reset (see README.md). Target-state note: span
names carrying pre-reset vocabulary are renamed with the ADR-0001 epic.

## Operations are OpenTelemetry spans

Every discrete atomic action Harmonic's runtime performs is an OTel span with
start, end, duration, pass/fail status, and subject attributes; spans nest
(an Epic integration; a member merge with its post-merge check; a tracker
poll). An Attempt is one Operation; the agent's internal tool calls and
Subagents stay Activity/Usage, not Operation spans. Instrumentation is
manual and deliberate (pure-ESM `tsc` build; no `require()`-patching
auto-instrumentation) — precision over magic.

Three planes, all to stdout and OTLP/HTTP:

- **Traces** — the Operations.
- **Logs** — a levelled logger (OTel Logs API) stamped with the active
  `trace_id`/`span_id`, replacing all `console.*`. Level convention:
  `debug` internal detail, `info` Operation lifecycle, `warn`
  retry/escalation/recoverable, `error` failure.
- **Metrics** — a counter per Operation type, an error counter, a duration
  histogram, recorded on span end, with a periodic in-memory summary.

**Exhaustive logging is doctrine, kept and strengthened by owner decision: an
action taken with no span or log entry is a defect.** Known gaps exist today
and closing them is standing work — the new merge path (merge, conflict
turns, post-merge check, revert) must be fully instrumented as part of the
ADR-0001 epic.

Mechanics: hybrid AsyncLocalStorage plus explicitly-stored parent context for
long-lived hierarchies; a custom `SpanProcessor` is the single fan-out point
(in-memory open-span registry, `operations` bus event, metrics, batch
exporter); **AlwaysOn sampling** — a single self-hosted instance samples
nothing, every opaque operation must be visible; holding spans open for the
real duration of long work is valid and is what makes "open span =
in-progress" work. Providers initialise once at process start and flush on
shutdown. Config via `OTEL_*` env/CLI only — never the settings table.
Stable span names use post-reset vocabulary (`harmonic.poll`,
`harmonic.attempt`, `harmonic.merge`, `harmonic.epic.integrate`, …); `ERROR`
status carries the reason as an attribute.

UI: the Operations rail — the live open-span tree plus a bounded ring buffer
of recently completed root Operations (`GET /api/operations` snapshot +
`operations` firehose event). Full history lives in the collector, not
Harmonic. OTel is never a Usage source (ADR-0008); Operation aggregates are
in-memory/exported, never persisted — with the one exception below.

## Scheduled Jobs

A **Scheduled Job** is recurring, Harmonic-scheduled background work on a
fixed cadence; each firing is one Operation span. One central Scheduler owns
every curated Job's timer — single-flight per Job, yield-aware (ADR-0007) —
and records `last_run_at` / `last_status` / `last_duration_ms` / `last_error`
in a small persistent registry keyed by Job identity (plus `workspace_id` for
the per-Workspace tracker poll), with `next_run` computed. The registry is a
deliberate, narrow exception to "operation aggregates are never persisted":
schedule bookkeeping must survive the restarts under which the span surface
resets. Visibility: a read-only `GET /api/scheduled-jobs` snapshot plus
firehose event feed the Scheduled Jobs section (name, scope, interval, last
run, duration, result, next run) — and each Job row links to its firing's
Operation span, so an operator can see the last run's own logs.

**The post-reset job roster** — each retained job states its inputs, its
terminal behaviour, and has **no lease, phase, or merge-journal dependency**:

- **Tracker poll** (per-Workspace instance, per-Workspace interval setting;
  its own resolution-failure lifecycle — a failed resolution surfaces as a
  disabled Job, never a fake next-run). Inputs: tracker API + ticket facts →
  mirrored rows (ADR-0004).
- **Session retirement sweep** (~5 min, hardcoded): idle Sessions past their
  disposition → retired. Never touches worktrees — worktree removal is
  Task-owned (ADR-0001).
- **Boot/periodic worktree reconciliation** (~30 min, hardcoded, deliberately
  slow — git subprocess load): reconciles `git worktree list` against the DB.
  It recreates what a live Task is missing and **auto-removes only clean
  worktrees of terminal Tasks; a dirty or unreadable worktree is surfaced
  for operator disposition, never deleted** — a crash must not cost
  uncommitted work.
- **Metrics summary** (the periodic reader).

Retired with the reset, with named dispositions: the work-context-lease sweep
(the lease concept is deleted; nothing replaces it) and the review-SLA sweep
(replaced by Task-owned worktree retention — removal only at terminal
disposition). High-frequency internal ticks (usage tailer, guardrail timers,
event-loop probe) stay out of the roster, mirroring the no-span rule for
non-discrete work.

## Consequences

- The `@opentelemetry/*` dependency surface is accepted: it replaces a
  bespoke logger, metrics, and live view.
- Explicit parent-context threading on long-lived hierarchies is plumbing the
  domain carries; exported traces must be well-formed and accurate, not
  merely a tidy in-memory tree.
- Span bookkeeping and the metrics summary must never block the loop
  (ADR-0007).

## Absorbed at the reset

Pre-reset 0037 in full (span names re-vocabularied; logging doctrine
strengthened), 0038 (roster rewritten as above, per-run job logs added by
owner decision). See README.md for the mapping.
