import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { App } from '../app.js';
import { runFacts, runs, tasks } from '../../db/schema.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';
import { costOfRuns } from '../serialize.js';
import { buildDaySeries } from '../stats-series.js';
import { costSchema, modelUsageSchema } from '../schemas.js';
import { yieldToEventLoop } from '../../reliability/yield.js';
import { activeExecutionDurationMs, durationPercentiles } from '../../domain/run-duration.js';
import { failuresByReason, isExecutionFailure, isReviewRejected } from '../../domain/run-failure.js';
import type { DispositionFact } from '../../domain/run-disposition.js';

/**
 * Aggregating this range is synchronous JS on the shared event loop (issue
 * #200): parsing each run's usage, merging, and building the day series all
 * block every other request. Past this wall-clock the aggregation is logged so
 * a growing DB making Stats a latent freeze is a visible signal, not a mystery.
 */
const SLOW_STATS_MS = 500;

/**
 * Only hand the event loop back mid-aggregation (issue #200) once the range is
 * big enough for the JS post-processing to be worth interleaving; below this a
 * yield is pure added latency for no isolation benefit.
 */
const YIELD_ROW_THRESHOLD = 500;

const querySchema = z.object({
  /** Epoch ms, inclusive; defaults to 0, i.e. all of recorded history. */
  from: z.coerce.number().int().nonnegative().default(0).meta({ example: 1783382400000 }),
  /**
   * Epoch ms, inclusive; when omitted, defaults to "now" — resolved in the
   * handler, not via a zod `.default(() => Date.now())`, so the generated
   * OpenAPI spec stays byte-stable (a live-timestamp default would make the
   * committed snapshot churn on every export — issue #74).
   */
  to: z.coerce.number().int().nonnegative().optional().meta({ example: 1784032260000 }),
  /** Scope to one Workspace's runs (ADR-0008); omitted means every Workspace. */
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
});

const daySeriesEntrySchema = z.object({
  /** Epoch ms at local midnight (server timezone) of the bucket's day. */
  day: z.number().meta({ example: 1783987200000 }),
  /** Cost of runs started that day; null when nothing could be priced. */
  totalUsd: z.number().nullable().meta({ example: 0.52 }),
  /** True when any of the day's tokens could not be priced (honest numbers: the value is a floor). */
  incomplete: z.boolean().meta({ example: false }),
  /** Input + output tokens of runs started that day (cache excluded); 0 when no usage was reported. */
  tokens: z.number().meta({ example: 21850 }),
  /** Count of runs started that day, whatever their state. */
  runs: z.number().meta({ example: 3 }),
  /** Execution failures started that day (failed-only, ADR-0028); the fails/day trend. */
  fails: z.number().meta({ example: 1 }),
});

const statsResponseSchema = z.object({
  /** The range actually applied, echoed back after defaulting. */
  from: z.number().meta({ example: 1783382400000 }),
  to: z.number().meta({ example: 1784032260000 }),
  /** Runs started in the range, whatever their state. */
  runCount: z.number().meta({ example: 3 }),
  /** Run counts keyed by RunState. */
  runsByState: z.record(z.string(), z.number()).meta({ example: { completed: 2, failed: 1 } }),
  /**
   * Failed-only Run count (ADR-0028): Runs in `state:'failed'` **excluding**
   * review-rejected ones. A rejection settles the Run to `state:'failed'` *and*
   * `review:'rejected'` together, so `runsByState.failed` folds rejections in —
   * this count is the honest numerator for the failure rate, which cancelled and
   * rejected Runs stay out of.
   */
  failedRuns: z.number().meta({ example: 1 }),
  /**
   * Review-rejected Run count (ADR-0028): Runs whose `review` is `rejected`. A
   * rejection settles the Run to `state:'failed'`, so `runsByState.failed` folds
   * these in — this count lets the reliability breakdown split them back out as
   * their own slice, kept out of the failure numerator (a reviewer's judgment
   * call, not an execution failure).
   */
  rejectedRuns: z.number().meta({ example: 1 }),
  /**
   * Execution failures (failed-only) bucketed by reason: the winning terminal
   * disposition (`failed`, `escalate`, `guardrail-trip`, `process-death`, …),
   * with an `unknown` bucket for a bare failure carrying no fact or reason.
   * Empty when nothing failed in the range.
   */
  failuresByReason: z.record(z.string(), z.number()).meta({ example: { failed: 4, escalate: 1, 'process-death': 1 } }),
  /**
   * p50 / p95 active-execution duration (ms) over the range's Runs — `agent-finish`
   * run_fact ts minus Run start, excluding review-park + landing wait, with a
   * wall-clock `finished − started` fallback (ADR-0028). Null when no Run in the
   * range has a measurable duration (honest numbers: never a fabricated 0).
   */
  durationMs: z
    .object({ p50: z.number(), p95: z.number() })
    .nullable()
    .meta({ example: { p50: 142000, p95: 512000 } }),
  /** Aggregate token counts; null when no run in the range reported usage. */
  totals: modelUsageSchema
    .extend({ totalTokens: z.number().meta({ example: 49450 }).nullable() })
    .nullable(),
  /** Per-model breakdown; only models whose runs reported usage appear. */
  models: z.record(z.string(), modelUsageSchema).meta({
    example: {
      'sonnet-5': { inputTokens: 18240, outputTokens: 3610, cacheReadTokens: 26400, cacheWriteTokens: 1200 },
    },
  }),
  /**
   * Per-agent-type token breakdown across the range (root session + each
   * Subagent type), from runs whose harness parsed a Process Tree. `root` is
   * the reserved root-session bucket, so the subagent share is
   * `1 − root/total`. Empty when no run in range carried per-agent data.
   */
  agents: z.record(z.string(), modelUsageSchema).meta({
    example: {
      root: { inputTokens: 40120, outputTokens: 5200, cacheReadTokens: 60300, cacheWriteTokens: 2400 },
      'code-reviewer': { inputTokens: 8100, outputTokens: 1400, cacheReadTokens: 12000, cacheWriteTokens: 600 },
    },
  }),
  toolCalls: z.record(z.string(), z.number()).meta({ example: { read: 14, edit: 6, bash: 3 } }),
  cost: costSchema.nullable(),
  /** Per-day cost buckets (only days with runs), ordered by day. */
  series: z.array(daySeriesEntrySchema),
});

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/stats',
    {
      schema: {
        tags: ['Stats'],
        description:
          'Usage, Cost, and run-state counts over a time range (by run start time). Operator only; not reachable with a run-scoped Run Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: querySchema,
        response: {
          200: statsResponseSchema.describe(
            'Usage, Cost, and run-state counts over the runs started in the range; totals and Cost count only what the runs actually reported and could be priced, so they are floors wherever `incomplete` is true.',
          ),
        },
      },
    },
    async (req) => {
      const { from, workspaceId } = req.query;
      // Omitted `to` means "up to now" — applied here so the query schema
      // carries no dynamic default (keeps the OpenAPI snapshot deterministic).
      const to = req.query.to ?? Date.now();
      const startedAtMs = Date.now();
      // runs carries no workspaceId of its own (it inherits via its Task —
      // ADR-0008), so scoping by Workspace means joining tasks.
      //
      // This range scan over the (large, growing) runs table is the heavy
      // aggregate #213 routes off the event-loop-blocking sync path: it runs on
      // the concurrent libsql read connection (ADR-0029 §5), so a big scan can
      // never freeze in-flight HTTP the way a synchronous better-sqlite3 `.all()`
      // would. Reads see the last committed WAL snapshot of the sync writer.
      // All three heavy range reads share one concurrent read-connection scope
      // (#213): the runs scan plus the two run_facts joins the KPI bands need, so
      // the whole blocking read phase is one `.read(...)` on the libsql read
      // sibling rather than several round-trips on it.
      const { rows, factRows, failFactRows } = await ctx.asyncReadDb.read(async (db) => {
        const rows =
          workspaceId === undefined
            ? await db
                .select()
                .from(runs)
                .where(and(gte(runs.startedAt, from), lte(runs.startedAt, to)))
                .all()
            : (
                await db
                  .select({ runs })
                  .from(runs)
                  .innerJoin(tasks, eq(runs.taskId, tasks.id))
                  .where(and(gte(runs.startedAt, from), lte(runs.startedAt, to), eq(tasks.workspaceId, workspaceId)))
                  .all()
              ).map((r) => r.runs);

        // Each Run's `agent-finish` run_fact ts, for the active-execution duration
        // below (ADR-0028): the agent's working time, not calendar time parked in
        // review/landing. Joined on the same range predicate rather than an
        // `IN (run ids)` — an "All time" range can hold thousands of Runs, past
        // SQLite's bound-parameter limit. Earliest fact ts wins if a Run somehow
        // logged more than one.
        const factRows =
          workspaceId === undefined
            ? await db
                .select({ runId: runFacts.runId, ts: runFacts.ts })
                .from(runFacts)
                .innerJoin(runs, eq(runFacts.runId, runs.id))
                .where(
                  and(
                    eq(runFacts.type, 'agent-finish/unresolved'),
                    gte(runs.startedAt, from),
                    lte(runs.startedAt, to),
                  ),
                )
                .all()
            : await db
                .select({ runId: runFacts.runId, ts: runFacts.ts })
                .from(runFacts)
                .innerJoin(runs, eq(runFacts.runId, runs.id))
                .innerJoin(tasks, eq(runs.taskId, tasks.id))
                .where(
                  and(
                    eq(runFacts.type, 'agent-finish/unresolved'),
                    gte(runs.startedAt, from),
                    lte(runs.startedAt, to),
                    eq(tasks.workspaceId, workspaceId),
                  ),
                )
                .all();

        // Every fact of the range's failed Runs, for the by-reason breakdown below:
        // the winning terminal disposition (issue #197) is derived from these, not
        // from the high-cardinality free-text `runs.reason`. Bounded to failed Runs
        // (`runs.state = 'failed'`) so a wide range doesn't drag in the whole log.
        // Same range-join predicate as above (an "All time" range can hold more Runs
        // than SQLite's bound-parameter limit).
        const failFactRows =
          workspaceId === undefined
            ? await db
                .select({ runId: runFacts.runId, seq: runFacts.seq, type: runFacts.type })
                .from(runFacts)
                .innerJoin(runs, eq(runFacts.runId, runs.id))
                .where(and(eq(runs.state, 'failed'), gte(runs.startedAt, from), lte(runs.startedAt, to)))
                .all()
            : await db
                .select({ runId: runFacts.runId, seq: runFacts.seq, type: runFacts.type })
                .from(runFacts)
                .innerJoin(runs, eq(runFacts.runId, runs.id))
                .innerJoin(tasks, eq(runs.taskId, tasks.id))
                .where(
                  and(
                    eq(runs.state, 'failed'),
                    gte(runs.startedAt, from),
                    lte(runs.startedAt, to),
                    eq(tasks.workspaceId, workspaceId),
                  ),
                )
                .all();

        return { rows, factRows, failFactRows };
      });

      const agentFinishTs = new Map<number, number>();
      for (const f of factRows) {
        const prev = agentFinishTs.get(f.runId);
        if (prev === undefined || f.ts < prev) agentFinishTs.set(f.runId, f.ts);
      }
      const factsByRun = new Map<number, DispositionFact[]>();
      for (const f of failFactRows) {
        const list = factsByRun.get(f.runId);
        if (list) list.push({ seq: f.seq, type: f.type });
        else factsByRun.set(f.runId, [{ seq: f.seq, type: f.type }]);
      }

      // Hand the loop back between the blocking reads and the heavy JS
      // aggregation below (issue #200), so a large Stats request interleaves
      // with other in-flight work instead of blocking it start-to-finish.
      if (rows.length >= YIELD_ROW_THRESHOLD) await yieldToEventLoop();

      const usages = rows
        .map((run) => (run.usage ? (JSON.parse(run.usage) as RunUsage) : null))
        .filter((u): u is RunUsage => u !== null);
      const merged = mergeUsage(usages);

      const runsByState: Record<string, number> = {};
      for (const run of rows) runsByState[run.state] = (runsByState[run.state] ?? 0) + 1;

      // Failure rate numerator (ADR-0028): failed-only. A review rejection writes
      // `state:'failed'` together with `review:'rejected'`, so filtering by state
      // alone silently counts rejections as execution failures — exclude them.
      const failures = rows.filter(isExecutionFailure);
      const failedRuns = failures.length;
      // Review rejections, split back out from the folded-in `runsByState.failed`
      // so the reliability breakdown shows them as their own (non-failure) slice.
      const rejectedRuns = rows.filter(isReviewRejected).length;
      // Execution failures bucketed by their winning terminal disposition (#197).
      const failReasons = failuresByReason(
        failures.map((r) => ({ facts: factsByRun.get(r.id) ?? [], reason: r.reason })),
      );

      // Active-execution duration (ADR-0028), from the agent-finish facts read
      // above: the fact ts − Run start, with a wall-clock fallback.
      const durations = rows
        .map((r) =>
          activeExecutionDurationMs({
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            agentFinishTs: agentFinishTs.get(r.id) ?? null,
          }),
        )
        .filter((d): d is number => d !== null);
      const durationMs = durationPercentiles(durations);

      // Cost, input+output tokens, and run count per local day (by run start
      // time) for the Stats chart's USD / Tokens / Runs series (issue #194).
      // buildDaySeries re-parses/re-merges each bucket's usage rather than
      // reusing the range-wide merge above — a deliberate cost of keeping it a
      // pure, ctx-free seam (pricing is injected); the per-bucket work is small.
      const series = buildDaySeries(rows, (dayRows) => costOfRuns(ctx, dayRows));

      // A day with runs but no priceable usage shows as unpriceable (null) in
      // the series. A range total that spans such a day is a floor, not an
      // exact figure — keep the headline Cost honest with the chart's "at
      // least" so the visible total and the accessible label agree (issue #92).
      const cost = costOfRuns(ctx, rows);
      const flooredCost =
        cost && !cost.incomplete && series.some((s) => s.totalUsd === null) ? { ...cost, incomplete: true } : cost;

      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= SLOW_STATS_MS) {
        console.warn(`[stats] slow aggregation: ${elapsedMs}ms over ${rows.length} runs — consider narrowing the range`);
      }

      return {
        from,
        to,
        runCount: rows.length,
        runsByState,
        failedRuns,
        rejectedRuns,
        failuresByReason: failReasons,
        durationMs,
        totals: merged?.totals ?? null,
        models: merged?.models ?? {},
        agents: merged?.agents ?? {},
        toolCalls: merged?.toolCalls ?? {},
        cost: flooredCost,
        series,
      };
    },
  );
}
