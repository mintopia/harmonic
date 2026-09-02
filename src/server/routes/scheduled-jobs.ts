import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { App } from '../app.js';
import { scheduledJobSchema } from '../schemas.js';
import { scheduledJobsToApi } from '../dto.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const scheduledJobsResponseSchema = listResponse('jobs', scheduledJobSchema);

export async function scheduledJobRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get('/scheduled-jobs', {
    schema: {
      tags: ['Scheduled Jobs'],
      description: 'Read-only registry of recurring Harmonic Scheduled Jobs, including durable last-run facts and computed next run.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      querystring: paginationQuerySchema,
      response: { 200: scheduledJobsResponseSchema.describe('The current Scheduled Job registry snapshot.') },
    },
  }, async (req) => {
    const { limit, offset } = req.query;
    const { items, total } = paginate(scheduledJobsToApi(await ctx.scheduler.snapshot()), { limit, offset });
    return { jobs: items, total };
  });
}
