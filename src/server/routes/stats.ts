import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { mergeUsage, type AttemptUsage } from '../../execution/usage.js';
import { costOfAttempts } from '../serialize.js';
import { buildDaySeries } from '../stats-series.js';
import { costSchema, modelUsageSchema, toolTokenUsageSchema } from '../schemas.js';
import { yieldToEventLoop } from '../../reliability/yield.js';
import { activeExecutionDurationMs, durationPercentiles } from '../../domain/attempt-duration.js';
import { failuresByReason, isExecutionFailure } from '../../domain/attempt-failure.js';
import { logger } from '../../logger.js';
import type { AttemptState } from '../../db/schema.js';

/** The stats view's `attemptsByState` keys: `passed` reads as `completed`, and
 * `escalated` (an Attempt-only state) folds into the generic `failed` bucket,
 * matching the `apiAttemptState` translation `attemptToApi` applies to the
 * Attempt resource itself. */
function statsAttemptState(state: AttemptState): 'running' | 'completed' | 'failed' | 'cancelled' {
  if (state === 'passed') return 'completed';
  if (state === 'escalated') return 'failed';
  return state;
}

/**
 * Aggregating this range is synchronous JS on the shared event loop (issue
 * #200): parsing each attempt's usage, merging, and building the day series all
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
  /** Scope to one Workspace's attempts (ADR-0008); omitted means every Workspace. */
  workspaceId: z.coerce.number().int().positive().optional().meta({ example: 1 }),
});

const daySeriesEntrySchema = z.object({
  /** Epoch ms at local midnight (server timezone) of the bucket's day. */
  day: z.number().meta({ example: 1783987200000 }),
  /** Cost of attempts started that day; null when nothing could be priced. */
  totalUsd: z.number().nullable().meta({ example: 0.52 }),
  /** True when any of the day's tokens could not be priced (honest numbers: the value is a floor). */
  incomplete: z.boolean().meta({ example: false }),
  /** Input + output tokens of attempts started that day (cache excluded); 0 when no usage was reported. */
  tokens: z.number().meta({ example: 21850 }),
  /** Count of attempts started that day, whatever their state. */
  attempts: z.number().meta({ example: 3 }),
  /** Execution failures started that day (failed-only, ADR-0028); the fails/day trend. */
  fails: z.number().meta({ example: 1 }),
});

const statsResponseSchema = z.object({
  /** The range actually applied, echoed back after defaulting. */
  from: z.number().meta({ example: 1783382400000 }),
  to: z.number().meta({ example: 1784032260000 }),
  /** Attempts started in the range, whatever their state. */
  attemptCount: z.number().meta({ example: 3 }),
  /** Attempt counts keyed by wire state. */
  attemptsByState: z.record(z.string(), z.number()).meta({ example: { completed: 2, failed: 1 } }),
  /** Failed-only Attempt count (ADR-0028): the failure-rate numerator; cancelled Attempts stay out. */
  failedAttempts: z.number().meta({ example: 1 }),
  /**
   * Execution failures (failed-only) bucketed by reason: the winning terminal
   * disposition (`failed`, `escalate`, `guardrail-trip`, `process-death`, …),
   * with an `unknown` bucket for a bare failure carrying no fact or reason.
   * Empty when nothing failed in the range.
   */
  failuresByReason: z.record(z.string(), z.number()).meta({ example: { failed: 4, escalate: 1, 'process-death': 1 } }),
  /**
   * p50 / p95 active-execution duration (ms) over the range's Attempts — wall-clock
   * `finished − started` (ADR-0028). Null when no Attempt in the range has settled
   * (honest numbers: never a fabricated 0).
   */
  durationMs: z
    .object({ p50: z.number(), p95: z.number() })
    .nullable()
    .meta({ example: { p50: 142000, p95: 512000 } }),
  /** Aggregate token counts; null when no attempt in the range reported usage. */
  totals: modelUsageSchema
    .extend({ totalTokens: z.number().meta({ example: 49450 }).nullable() })
    .nullable(),
  /** Per-model breakdown; only models whose attempts reported usage appear. */
  models: z.record(z.string(), modelUsageSchema).meta({
    example: {
      'sonnet-5': { inputTokens: 18240, outputTokens: 3610, cacheReadTokens: 26400, cacheWriteTokens: 1200 },
    },
  }),
  /**
   * Per-agent-type token breakdown across the range (root session + each
   * Subagent type), from attempts whose harness parsed a Process Tree. `root` is
   * the reserved root-session bucket, so the subagent share is
   * `1 − root/total`. Empty when no attempt in range carried per-agent data.
   */
  agents: z.record(z.string(), modelUsageSchema).meta({
    example: {
      root: { inputTokens: 40120, outputTokens: 5200, cacheReadTokens: 60300, cacheWriteTokens: 2400 },
      'code-reviewer': { inputTokens: 8100, outputTokens: 1400, cacheReadTokens: 12000, cacheWriteTokens: 600 },
    },
  }),
  /** Output-token attribution across turns whose native transcripts exposed
   * tool calls; absent when no attempt in the range had that evidence. */
  toolTokens: z.record(z.string(), toolTokenUsageSchema).optional(),
  /** Parsed output from no-tool turns; absent with toolTokens when attribution
   * could not be collected. */
  reasoning: toolTokenUsageSchema.optional(),
  toolCalls: z.record(z.string(), z.number()).meta({ example: { read: 14, edit: 6, bash: 3 } }),
  cost: costSchema.nullable(),
  /** Per-day cost buckets (only days with attempts), ordered by day. */
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
          'Usage, Cost, and attempt-state counts over a time range (by attempt start time). Operator only; not reachable with an attempt-scoped Attempt Key.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: querySchema,
        response: {
          200: statsResponseSchema.describe(
            'Usage, Cost, and attempt-state counts over the attempts started in the range; totals and Cost count only what the attempts actually reported and could be priced, so they are floors wherever `incomplete` is true.',
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
      // Local libsql executes file-backed queries inline despite returning a
      // Promise. The typed worker RPC keeps all four growing range scans off the
      // server event loop while preserving the separate WAL reader from #213.
      const { rows, attemptReasons, toolTotals } = await ctx.statsReader.read({
        from,
        to,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });

      const attemptReasonById = new Map(attemptReasons.map((r) => [r.attemptId, r.reason]));

      // Hand the loop back between the blocking reads and the heavy JS
      // aggregation below (issue #200), so a large Stats request interleaves
      // with other in-flight work instead of blocking it start-to-finish.
      if (rows.length >= YIELD_ROW_THRESHOLD) await yieldToEventLoop();

      const usages = rows
        .map((run) => (run.usage ? (JSON.parse(run.usage) as AttemptUsage) : null))
        .filter((u): u is AttemptUsage => u !== null);
      const merged = mergeUsage(usages);
      const toolCalls: Record<string, number> = {};
      for (const totals of Object.values(toolTotals.byTask)) {
        for (const [toolName, count] of Object.entries(totals)) toolCalls[toolName] = (toolCalls[toolName] ?? 0) + count;
      }

      const attemptsByState: Record<string, number> = {};
      for (const run of rows) {
        const state = statsAttemptState(run.state);
        attemptsByState[state] = (attemptsByState[state] ?? 0) + 1;
      }

      // Failure rate numerator (ADR-0028): failed-only; cancelled Runs stay out.
      const failures = rows.filter(isExecutionFailure);
      const failedAttempts = failures.length;
      const failReasons = failuresByReason(
        failures.map((r) => ({ attemptReason: attemptReasonById.get(r.id) ?? null, detailReason: r.reason })),
      );

      const durations = rows
        .map((r) =>
          activeExecutionDurationMs({
            startedAt: r.startedAt,
            finishedAt: r.endedAt,
            // No dedicated agent-finish signal — the disposition lives on
            // `attempts.reason` (ADR-0001): wall-clock `finished − started`
            // for every Attempt.
            agentFinishTs: null,
          }),
        )
        .filter((d): d is number => d !== null);
      const durationMs = durationPercentiles(durations);

      const series = buildDaySeries(rows, costOfAttempts);

      // A day with runs but no priceable usage shows as unpriceable (null) in
      // the series. A range total that spans such a day is a floor, not an
      // exact figure — keep the headline Cost honest with the chart's "at
      // least" so the visible total and the accessible label agree (issue #92).
      const cost = costOfAttempts(rows);
      const flooredCost =
        cost && !cost.incomplete && series.some((s) => s.totalUsd === null) ? { ...cost, incomplete: true } : cost;

      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs >= SLOW_STATS_MS) {
        logger.warn(`[stats] slow aggregation: ${elapsedMs}ms over ${rows.length} runs — consider narrowing the range`);
      }

      return {
        from,
        to,
        attemptCount: rows.length,
        attemptsByState,
        failedAttempts,
        failuresByReason: failReasons,
        durationMs,
        totals: merged?.totals ?? null,
        models: merged?.models ?? {},
        agents: merged?.agents ?? {},
        ...(merged?.toolTokens ? { toolTokens: merged.toolTokens } : {}),
        ...(merged?.reasoning ? { reasoning: merged.reasoning } : {}),
        toolCalls,
        cost: flooredCost,
        series,
      };
    },
  );
}
