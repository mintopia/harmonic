import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ExecutionContext } from '../app.js';
import { worktreeInventorySchema } from '../schemas.js';
import { worktreesToApi } from '../dto.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const worktreesResponseSchema = listResponse('worktrees', worktreeInventorySchema);

export async function worktreeRoutes(fastify: FastifyInstance, ctx: Pick<ExecutionContext, 'worktreeInventory'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get('/worktrees', {
    schema: {
      tags: ['Worktrees'],
      description: 'A read-time inventory of every Git worktree joined to mirrored Tasks and Epics. The state is never persisted.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      querystring: paginationQuerySchema,
      response: { 200: worktreesResponseSchema.describe('The current worktree inventory snapshot.') },
    },
  }, async (req) => {
    const { limit, offset } = req.query;
    const { items, total } = paginate([...worktreesToApi(await ctx.worktreeInventory.snapshot())], { limit, offset });
    return { worktrees: items, total };
  });
}
