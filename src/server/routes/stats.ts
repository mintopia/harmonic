import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { App } from '../app.js';
import { runs, tasks } from '../../db/schema.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';
import { costOfRuns } from '../serialize.js';
import { costSchema, modelUsageSchema } from '../schemas.js';

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
});

const statsResponseSchema = z.object({
  /** The range actually applied, echoed back after defaulting. */
  from: z.number().meta({ example: 1783382400000 }),
  to: z.number().meta({ example: 1784032260000 }),
  /** Runs started in the range, whatever their state. */
  runCount: z.number().meta({ example: 3 }),
  /** Run counts keyed by RunState. */
  runsByState: z.record(z.string(), z.number()).meta({ example: { completed: 2, failed: 1 } }),
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
      // runs carries no workspaceId of its own (it inherits via its Task —
      // ADR-0008), so scoping by Workspace means joining tasks.
      const rows = (
        workspaceId === undefined
          ? ctx.db
              .select()
              .from(runs)
              .where(and(gte(runs.startedAt, from), lte(runs.startedAt, to)))
              .all()
          : ctx.db
              .select({ runs })
              .from(runs)
              .innerJoin(tasks, eq(runs.taskId, tasks.id))
              .where(and(gte(runs.startedAt, from), lte(runs.startedAt, to), eq(tasks.workspaceId, workspaceId)))
              .all()
              .map((r) => r.runs)
      );

      const usages = rows
        .map((run) => (run.usage ? (JSON.parse(run.usage) as RunUsage) : null))
        .filter((u): u is RunUsage => u !== null);
      const merged = mergeUsage(usages);

      const runsByState: Record<string, number> = {};
      for (const run of rows) runsByState[run.state] = (runsByState[run.state] ?? 0) + 1;

      // Cost per local day (by run start time) for the Stats chart.
      const byDay = new Map<number, typeof rows>();
      for (const run of rows) {
        const d = new Date(run.startedAt);
        d.setHours(0, 0, 0, 0);
        const day = d.getTime();
        const bucket = byDay.get(day);
        if (bucket) bucket.push(run);
        else byDay.set(day, [run]);
      }
      const series = [...byDay.entries()]
        .sort(([a], [b]) => a - b)
        .map(([day, dayRows]) => {
          const dayCost = costOfRuns(ctx, dayRows);
          return { day, totalUsd: dayCost?.totalUsd ?? null, incomplete: dayCost?.incomplete ?? false };
        });

      // A day with runs but no priceable usage shows as unpriceable (null) in
      // the series. A range total that spans such a day is a floor, not an
      // exact figure — keep the headline Cost honest with the chart's "at
      // least" so the visible total and the accessible label agree (issue #92).
      const cost = costOfRuns(ctx, rows);
      const flooredCost =
        cost && !cost.incomplete && series.some((s) => s.totalUsd === null) ? { ...cost, incomplete: true } : cost;

      return {
        from,
        to,
        runCount: rows.length,
        runsByState,
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
