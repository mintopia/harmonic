import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { App } from '../app.js';
import { activityProcessSchema } from '../schemas.js';
import { activitySnapshot } from '../serialize.js';

const activityResponseSchema = z.object({ processes: z.array(activityProcessSchema) });

export async function activityRoutes(fastify: FastifyInstance): Promise<void> {
  const { ctx } = fastify as App;
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/activity',
    {
      schema: {
        tags: ['Activity'],
        description:
          'Instance-wide snapshot of every capacity-consuming Run and warm Conversation across Workspaces (ADR 0010). ' +
          'Runs come from persisted state and join their latest live Usage, context fill, derived Cost, current-activity ' +
          'line, and Process Tree when available. The Activity view loads this once on page-load, then follows the live ' +
          '`run_usage` firehose. A Read Key (a read-scoped API key) sees Runs only — Conversations are excluded, ' +
          'matching the firehose filter.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        response: {
          200: activityResponseSchema.describe(
            'Every live process across Workspaces (Runs then Conversations); an empty array when nothing is running. ' +
              'Unordered beyond that — the Activity view applies its own attention ranking.',
          ),
        },
      },
    },
    async (req) => {
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const token = bearer ?? (req.query as Record<string, string | undefined>)?.token;
      const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
      return { processes: await activitySnapshot(ctx, !readOnly) };
    },
  );
}
