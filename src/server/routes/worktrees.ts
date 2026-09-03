import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ExecutionContext } from '../app.js';
import { DomainError } from '../../domain/errors.js';
import { errorResponse, worktreeInventorySchema } from '../schemas.js';
import { worktreesToApi } from '../dto.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const worktreesResponseSchema = listResponse('worktrees', worktreeInventorySchema);
const cleanupResponseSchema = z.object({ removed: z.boolean() });
const cleanupParamsSchema = z.object({ id: z.string().min(1).meta({ example: 'WzEsIi9kYXRhL3dvcmt0cmVlcy90YXNrLTQyIl0' }) });

export async function worktreeRoutes(fastify: FastifyInstance, ctx: Pick<ExecutionContext, 'worktreeInventory' | 'forceCleanupWorktree'>): Promise<void> {
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

  app.post('/worktrees/:id/cleanup', {
    schema: {
      tags: ['Worktrees'],
      description: 'Human-only, confirmed removal of a managed worktree and its Harmonic branch. Dirty and unreadable worktrees are never removed automatically; this is the explicit operator disposition path.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      params: cleanupParamsSchema,
      response: {
        200: cleanupResponseSchema.describe('Whether the worktree was removed.'),
        403: errorResponse('The worktree is outside Harmonic’s managed worktree root.'),
        404: errorResponse('No managed worktree exists for this Task.'),
      },
    },
  }, async (req) => {
    const removed = await ctx.forceCleanupWorktree(req.params.id);
    if (removed === null) throw new DomainError('not_found', 'no worktree exists for this inventory entry');
    return { removed };
  });
}
