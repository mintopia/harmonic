import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { timelineResponseSchema } from '../schemas.js';
import { timelineAttempts } from '../serialize.js';

export async function timelineRoutes(fastify: FastifyInstance, ctx: AppContext): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/timeline',
    {
      schema: {
        tags: ['Activity'],
        description:
          'Every task Attempt in one Workspace whose run window overlaps [from, to], as fleet-timeline spans — ' +
          'lane is the harness, plus the attempt outcome and the window it occupied. Read from persisted attempt ' +
          'history, so it spans finished work the live Activity snapshot no longer retains. A still-running Attempt ' +
          'has a null endedAt; the client extends its bar to now. Powers the scrubbable Timeline view.',
        security: [{ bearerAuth: [] }, { sessionCookie: [] }],
        querystring: z.object({
          workspaceId: z.coerce.number().int(),
          from: z.coerce.number().int(),
          to: z.coerce.number().int(),
        }),
        response: {
          200: timelineResponseSchema,
        },
      },
    },
    async (req) => {
      const { workspaceId, from, to } = req.query;
      const attempts = await timelineAttempts(ctx, workspaceId, from, to);
      return { attempts, from, to };
    },
  );
}
