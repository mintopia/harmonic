import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { mergeUsage, type AttemptUsage } from '../../execution/usage.js';
import { costOfAttempts } from '../dto.js';
import { buildDaySeries } from '../stats-series.js';
import { costSchema, modelUsageSchema, toolTokenUsageSchema } from '../schemas.js';
import { yieldToEventLoop } from '../../reliability/yield.js';
import { activeExecutionDurationMs, durationPercentiles } from '../../domain/attempt-duration.js';
import { failuresByReason, isExecutionFailure } from '../../domain/attempt-failure.js';
import {
  attemptsPerTask,
  byWorkspace,
  costPerMergedTask,
  gateOutcomes,
  guardrailTripsByDimension,
  tasksMergedByDay,
  verdicts,
} from '../stats-aggregates.js';
import { logger } from '../../logger.js';
import type { AttemptState } from '../../db/schema.js';
import type { StatsRange, StatsWorkerClient } from '../../db/stats-reader.js';

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

/** Critic or command verdict tallies at verification-attempt grain (ADR-0014). */
const verdictCountsSchema = z.object({
  pass: z.number().meta({ example: 12 }),
  /** A `fail` verdict — the outcome that blocks a merge. */
  block: z.number().meta({ example: 3 }),
  inconclusive: z.number().meta({ example: 1 }),
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
  // --- Task-grain, verification, guardrail & per-Workspace aggregates (ADR-0014).
  // Task-grain figures count a Task once by its settling event, never per
  // Attempt, so a self-healed Task does not inflate throughput or per-task cost.
  /**
   * Tasks merged per calendar day (server timezone), keyed by the merge event's
   * day — not the first Attempt's. A Task counts once, on its merge day. Only
   * days that held a merge appear (the client fills gaps); ordered by day.
   */
  tasksMergedByDay: z
    .array(
      z.object({
        day: z.number().meta({ example: 1783987200000 }),
        count: z.number().meta({ example: 4 }),
      }),
    )
    .meta({ example: [{ day: 1783987200000, count: 4 }] }),
  /** Distribution of Attempts-to-settle over merged Tasks (open/cancelled excluded);
   * one is best (merged first-try, no self-heal). */
  attemptsPerTask: z
    .object({
      '1': z.number(),
      '2': z.number(),
      '3': z.number(),
      '4+': z.number(),
    })
    .meta({ example: { '1': 18, '2': 5, '3': 2, '4+': 1 } }),
  /** Merged spend ÷ merged Tasks, with reverted/abandoned spend reported beside
   * it so the split reconciles. Costs null-stick per ADR-0008 (a floor, never a
   * fake zero). */
  costPerMergedTask: z
    .object({
      mergedTasks: z.number().meta({ example: 26 }),
      mergedCost: costSchema.nullable(),
      wastedCost: costSchema.nullable(),
    })
    .meta({
      example: {
        mergedTasks: 26,
        mergedCost: { totalUsd: 41.2, byModel: { 'sonnet-5': 41.2 }, incomplete: false },
        wastedCost: { totalUsd: 6.4, byModel: { 'sonnet-5': 6.4 }, incomplete: false },
      },
    }),
  /** Verification verdicts at verification-attempt grain; critic and command
   * counted separately, never folded together. */
  verdicts: z
    .object({ critic: verdictCountsSchema, command: verdictCountsSchema })
    .meta({
      example: {
        critic: { pass: 24, block: 5, inconclusive: 2 },
        command: { pass: 30, block: 1, inconclusive: 0 },
      },
    }),
  /** How settled Tasks left the merge gate (ADR-0001): auto-merged, escalated to
   * a human, or merged-then-reverted on a red post-merge check. */
  gateOutcomes: z
    .object({
      autoMerged: z.number().meta({ example: 26 }),
      escalated: z.number().meta({ example: 4 }),
      revertedOnRed: z.number().meta({ example: 1 }),
    })
    .meta({ example: { autoMerged: 26, escalated: 4, revertedOnRed: 1 } }),
  /** Guardrail trip counts keyed by dimension (ADR-0002), once per Attempt per
   * dimension; a dimension that never tripped is absent. */
  guardrailTrips: z
    .record(z.string(), z.number())
    .meta({ example: { 'wall-clock': 3, tokens: 1, 'tool-timeout': 2 } }),
  /** The attempt-grain aggregates grouped by owning Workspace, ordered by cost.
   * Billable tokens stay split input/output (no combined scalar). */
  byWorkspace: z
    .array(
      z.object({
        workspaceId: z.number().meta({ example: 1 }),
        name: z.string().meta({ example: 'harmonic' }),
        cost: costSchema.nullable(),
        inputTokens: z.number().meta({ example: 18240 }),
        outputTokens: z.number().meta({ example: 3610 }),
        tasks: z.number().meta({ example: 12 }),
        /** Failed-only rate (ADR-0028) over non-cancelled Attempts; null when none ran. */
        failureRate: z.number().nullable().meta({ example: 0.08 }),
      }),
    )
    .meta({
      example: [
        {
          workspaceId: 1,
          name: 'harmonic',
          cost: { totalUsd: 41.2, byModel: { 'sonnet-5': 41.2 }, incomplete: false },
          inputTokens: 18240,
          outputTokens: 3610,
          tasks: 12,
          failureRate: 0.08,
        },
      ],
    }),
});

/** Path param for the Epic-scoped surface: the Epic ticket's tracker ref. */
const epicParamsSchema = z.object({
  ref: z.coerce.number().int().positive().meta({ example: 410 }),
});

/**
 * The one aggregation both Stats surfaces share (issue #410): a `StatsRange` in,
 * the full Stats response out. The fleet route passes a Workspace-or-unscoped
 * range; the Epic route adds `epicRef`. Every honest-numbers rule and locked
 * formula (ADR-0008, ADR-0014) is identical — only the reader's scope differs.
 */
async function computeStats(statsReader: StatsWorkerClient, range: StatsRange) {
  const { from, to } = range;
  const startedAtMs = Date.now();
  // Local libsql executes file-backed queries inline despite returning a
  // Promise. The typed worker RPC keeps all four growing range scans off the
  // server event loop while preserving the separate WAL reader from #213.
  const { rows, attemptReasons, toolTotals, workspaces, taskWorkspaces, settleEvents, settledTaskAttempts, verifications, guardrailTrips } =
    await statsReader.read(range);

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
    tasksMergedByDay: tasksMergedByDay(settleEvents),
    attemptsPerTask: attemptsPerTask(settleEvents, settledTaskAttempts),
    costPerMergedTask: costPerMergedTask(settleEvents, settledTaskAttempts),
    verdicts: verdicts(verifications),
    gateOutcomes: gateOutcomes(settleEvents),
    guardrailTrips: guardrailTripsByDimension(guardrailTrips),
    byWorkspace: byWorkspace(rows, taskWorkspaces, workspaces),
  };
}

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
      return computeStats(ctx.statsReader, { from, to, ...(workspaceId === undefined ? {} : { workspaceId }) });
    },
  );

  app.get(
    '/epics/:ref/stats',
    {
      schema: {
        tags: ['Stats'],
        description:
          "Usage, Cost, and attempt-state counts scoped to one Epic's child Tasks (ADR-0014), over a time range by attempt start time. Same shape as the fleet Stats surface. Operator only; not reachable with an attempt-scoped Attempt Key.",
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        params: epicParamsSchema,
        querystring: querySchema,
        response: {
          200: statsResponseSchema.describe(
            "Usage, Cost, and attempt-state counts over the Epic's attempts started in the range; totals and Cost count only what the attempts actually reported and could be priced, so they are floors wherever `incomplete` is true.",
          ),
        },
      },
    },
    async (req) => {
      const { ref } = req.params;
      const { from, workspaceId } = req.query;
      // Omitted `to` means "up to now" — see the fleet route above.
      const to = req.query.to ?? Date.now();
      // `workspaceId` narrows when the same Epic ref exists in more than one
      // Workspace (refs are unique only per Workspace, ADR-0004); omitted, the
      // Epic scope spans every Workspace holding a child of this ref.
      return computeStats(ctx.statsReader, {
        from,
        to,
        epicRef: ref,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
    },
  );
}
