import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ExecutionContext } from '../app.js';
import { flaggedWorktreeSchema } from '../schemas.js';
import { flaggedWorktreesToApi } from '../dto.js';
import { listResponse, paginate, paginationQuerySchema } from '../pagination.js';

const flaggedWorktreesResponseSchema = listResponse('worktrees', flaggedWorktreeSchema);

export async function flaggedWorktreeRoutes(fastify: FastifyInstance, ctx: Pick<ExecutionContext, 'flaggedWorktrees'>): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  app.get('/flagged-worktrees', {
    schema: {
      tags: ['Worktree Reconciliation'],
      description: 'Read-only registry of worktrees the reconciler (ADR-0010) will not delete — dirty, unreadable, or unrecognized — awaiting operator disposition.',
      security: [{ bearerAuth: [] }, { sessionCookie: [] }],
      querystring: paginationQuerySchema,
      response: { 200: flaggedWorktreesResponseSchema.describe('The current flagged-worktree registry snapshot.') },
    },
  }, async (req) => {
    const { limit, offset } = req.query;
    const { items, total } = paginate([...flaggedWorktreesToApi(ctx.flaggedWorktrees.snapshot())], { limit, offset });
    return { worktrees: items, total };
  });
}
