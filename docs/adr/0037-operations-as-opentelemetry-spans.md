# Decision: Operations are OpenTelemetry spans — adopt OTel for tracing, logging, and metrics

Status: accepted
Date: 2026-08-22

## Context

Harmonic is a black box in operation. Agent execution is well observed (Runs,
Run Events, the Activity view, Usage), but everything the *runtime itself* does —
polling a Tracker, picking a Task, cutting an Integration branch, rebasing and
fast-forwarding a Member onto it, verifying, landing a finished worktree,
retiring a Session — happens with no name, no record, and no live view. When a
merge or a poll misbehaves it is invisible; when it succeeds it flashes past
unseen. There is also no logging substrate at all: `Fastify({ logger: false })`,
~18 raw `console.*` sites, no levels, no correlation, no aggregate counts. The
only existing seam is an injected `onError(msg)` hook on a handful of
coordinators.

We want one abstraction that answers "**what is Harmonic doing right now**,"
feeds structured stdout logs, keeps in-memory aggregate counts, and exports to
standard tooling — rather than three parallel mechanisms. Telemetry is a solved
problem with a standard: OpenTelemetry. The unit of "a discrete atomic thing
Harmonic is doing" maps exactly onto an OTel **span**.

Constraints from the codebase:

- `src/` is pure ESM (`"type": "module"`, NodeNext), built with plain `tsc`, not
  bundled. OTel's `require()`-patching **auto**-instrumentation does not work
  without ESM loader hooks — so we instrument **manually**. This fits the model:
  Operations are things we deliberately mark, not ambient HTTP spans.
- No OTel dependency is installed today. **ADR-0009** removed OTel as the *Usage*
  source (Usage now comes from native session-log parsing). This ADR does **not**
  revert that: OTel here is for operation tracing / logs / metrics, never for
  Usage. The two do not overlap.

## Decision

Adopt OpenTelemetry as Harmonic's observability substrate, manually instrumented.

- **Operation ≡ span.** A discrete atomic action *Harmonic's runtime* performs is
  an OTel span with a start, end, duration, pass/fail status, and subject
  attributes. Spans **nest** (Epic → Member land → `rebase`/`ff`). A **Run is one
  Operation**; the agent's internal tool-calls and Subagents are **not**
  decomposed into Operation spans — that stays Activity / Usage. (See `CONTEXT.md`
  → *Operation*.)

- **Three planes, all to stdout and OTLP/HTTP:**
  - **Traces** — the Operations.
  - **Logs** — a levelled logger (OTel Logs API) stamped with the active
    `trace_id`/`span_id`, replacing all `console.*`.
  - **Metrics** — a counter per Operation type, an error counter, and a duration
    histogram, recorded on span end; a periodic reader prints an in-memory
    summary to stdout and exports via OTLP.

- **Linkage & the live registry.** Parent/child linkage is **hybrid**:
  AsyncLocalStorage for spans that share a synchronous/awaited call chain, and an
  **explicitly stored parent `SpanContext`** on the few long-lived hierarchies
  whose children open in a *later* async tick (the Run lifecycle
  execute→verify→land; the Epic lifecycle cut→members→whole-epic-verify→land→
  retire). An in-progress Operation is a span **held open for its real duration**.
  A custom `SpanProcessor`'s set of started-but-not-ended spans **is** the
  in-memory registry: `onStart` adds, `onEnd` removes. The same processor is the
  only fan-out point — it feeds the registry, emits the `operations` bus event,
  and records the metrics; the standard batch exporter is its other tap. Traces
  exported to OTLP must be well-formed and accurate (correct parent/child,
  timings, status), not merely a tidy in-memory tree.

- **Sampling: AlwaysOn.** A single self-hosted instance at this volume samples
  nothing — every opaque merge must be visible. If sampling is ever needed it is
  **tail-based in a collector sidecar**, never head-based in Harmonic.

- **Config via `OTEL_*` env vars + CLI arguments**, resolved at process init in
  `cli.ts` before the app builds. Telemetry is a launch/deploy concern; it does
  **not** enter the `appConfigSchema` settings table or the operator UI.

- **Providers** (Tracer/Logger/Meter) initialise once at process start and
  **flush + shut down gracefully** on `SIGTERM` / daemon stop, so in-flight spans
  and the final metric interval are not lost. Resource: `service.name=harmonic`,
  `service.version` from `package.json`. Stable span names (`harmonic.poll`,
  `harmonic.run`, `harmonic.epic.land`, `harmonic.merge.member`, …); `ERROR`
  status carries the reason as an attribute.

- **UI.** A new **Operations** rail, beside Activity (shared live backend, distinct
  purpose per `CONTEXT.md`): the live open-span tree plus a **bounded in-memory
  rolling history** of recently-completed root Operations (ring buffer), so a fast
  merge/poll leaves a trace. Delivered as a `GET /api/operations` snapshot +
  `operations` firehose event, consumed snapshot-on-load + firehose-merge like
  Activity. Full history lives in the collector, not Harmonic.

- **Level convention** for the exhaustive logging retrofit: `debug` = internal
  detail, `info` = Operation lifecycle, `warn` = retry / escalation / recoverable,
  `error` = failure.

- **Exhaustive logging is in scope.** Every non-trivial code path gains levelled
  logging and no raw `console.*` survives — opening the black box is the goal, not
  a follow-on.

## Consequences

- A new dependency surface (`@opentelemetry/*`: api, sdk-trace-node, sdk-logs,
  api-logs, sdk-metrics, resources, semantic-conventions, and the OTLP/HTTP
  exporters). Accepted: it is the standard, and it replaces a bespoke logger +
  metrics + live-view we would otherwise hand-roll.
- Manual instrumentation is deliberate work per Operation — nothing is traced by
  magic. The upside is precision (only Harmonic's own actions are spans) and no
  ESM loader-hook fragility.
- Holding spans open for minutes/hours (a Run) is unusual for OTel but valid, and
  is what makes "open span = in-progress" work. The batch exporter ships them on
  end; the collector, not Harmonic, holds history.
- Explicit parent-context threading on the long-lived hierarchies is extra
  plumbing the domain must carry, and getting it wrong yields broken traces —
  hence the "accurate export" acceptance bar.
- **Does not touch Usage** (ADR-0009 stands) and adds **no** settings-schema /
  WS-REST-parity work (config is env/CLI only).
- The event-loop guarantee (ADR-0029/0036) is respected: the periodic metrics
  summary and any span bookkeeping must not themselves block the loop.

## Supersedes

None. Relates to ADR-0009 (OTel is re-introduced for operation telemetry only,
not Usage) and ADR-0031 (DB holds tool aggregates; Operation aggregates are
in-memory / exported, never persisted).
