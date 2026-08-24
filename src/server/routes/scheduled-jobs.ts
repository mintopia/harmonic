import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { scheduledJobSchema } from '../schemas.js';
import { scheduledJobsToApi } from '../serialize.js';

const scheduledJobsResponseSchema = z.object({ jobs: z.array(scheduledJobSchema) });

export async function scheduledJobRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get('/scheduled-jobs', {
    schema: {
      tags: ['Scheduled Jobs'],
      description: 'Read-only registry of recurring Harmonic Scheduled Jobs (ADR-0038), including durable last-run facts and computed next run.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      response: { 200: scheduledJobsResponseSchema.describe('The current Scheduled Job registry snapshot.') },
    },
  }, async () => ({ jobs: scheduledJobsToApi(await ctx.scheduler.snapshot()) }));
}
