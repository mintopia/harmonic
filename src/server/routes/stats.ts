import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, gte, lte } from 'drizzle-orm';
import type { App } from '../app.js';
import { runs } from '../../db/schema.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';
import { costOfRuns } from '../serialize.js';
import { costSchema, modelUsageSchema } from '../schemas.js';

const querySchema = z.object({
  from: z.coerce.number().int().nonnegative().default(0),
  to: z.coerce.number().int().nonnegative().default(() => Date.now()),
});

const daySeriesEntrySchema = z.object({
  /** Epoch ms at local midnight (server timezone) of the bucket's day. */
  day: z.number(),
  /** Cost of runs started that day; null when nothing could be priced. */
  totalUsd: z.number().nullable(),
  /** True when any of the day's tokens could not be priced (honest numbers: the value is a floor). */
  incomplete: z.boolean(),
});

const statsResponseSchema = z.object({
  from: z.number(),
  to: z.number(),
  runCount: z.number(),
  /** Run counts keyed by RunState. */
  runsByState: z.record(z.string(), z.number()),
  totals: modelUsageSchema.extend({ totalTokens: z.number().nullable() }).nullable(),
  models: z.record(z.string(), modelUsageSchema),
  toolCalls: z.record(z.string(), z.number()),
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
        response: { 200: statsResponseSchema },
      },
    },
    async (req) => {
      const { from, to } = req.query;
      const rows = ctx.db
        .select()
        .from(runs)
        .where(and(gte(runs.startedAt, from), lte(runs.startedAt, to)))
        .all();

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

      return {
        from,
        to,
        runCount: rows.length,
        runsByState,
        totals: merged?.totals ?? null,
        models: merged?.models ?? {},
        toolCalls: merged?.toolCalls ?? {},
        cost: costOfRuns(ctx, rows),
        series,
      };
    },
  );
}
