import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { activityProcessSchema } from '../schemas.js';
import { activitySnapshot } from '../serialize.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const activityResponseSchema = listResponse('processes', activityProcessSchema);

export async function activityRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/activity',
    {
      schema: {
        tags: ['Activity'],
        description:
          'Instance-wide snapshot of every capacity-consuming Attempt and warm Conversation across Workspaces (ADR 0010). ' +
          'Attempts come from persisted state and join their latest live Usage, context fill, derived Cost, current-activity ' +
          'line, and Process Tree when available. The Activity view loads this once on page-load, then follows the live ' +
          '`attempt_usage` firehose. A Read Key (a read-scoped API key) sees Attempts only — Conversations are excluded, ' +
          'matching the firehose filter.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: paginationQuerySchema.extend({
          /** A bearer token passed as a query param (e.g. an EventSource that cannot set an Authorization header). */
          token: z.string().optional(),
        }),
        response: {
          200: activityResponseSchema.describe(
            'Every live process across Workspaces (Attempts then Conversations); an empty array when nothing is running. ' +
              'Unordered beyond that — the Activity view applies its own attention ranking.',
          ),
        },
      },
    },
    async (req) => {
      const { limit, offset, token: queryToken } = req.query;
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const token = bearer ?? queryToken;
      const readOnly = (token ? await ctx.auth.verifyKey(token) : null)?.scope === 'read';
      const { items, total } = paginate(await activitySnapshot(ctx, !readOnly), { limit, offset });
      return { processes: items, total };
    },
  );
}
