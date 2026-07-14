import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, gte, lte } from 'drizzle-orm';
import type { App } from '../app.js';
import { runs } from '../../db/schema.js';
import { mergeUsage, type RunUsage } from '../../execution/usage.js';

const querySchema = z.object({
  from: z.coerce.number().int().nonnegative().default(0),
  to: z.coerce.number().int().nonnegative().default(() => Date.now()),
});

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;

  fastify.get('/stats', async (req) => {
    const { from, to } = querySchema.parse(req.query);
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

    return {
      from,
      to,
      runCount: rows.length,
      runsByState,
      totals: merged?.totals ?? null,
      models: merged?.models ?? {},
      toolCalls: merged?.toolCalls ?? {},
    };
  });
}
